import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THRESHOLDS } from '@noltri/schema';
import { InMemoryRepository } from '../src/in-memory';
import { SqliteRepository } from '../src/sqlite';
import { inspectSqliteLineage, migrateSqlite, SQLITE_MIGRATIONS } from '../src/sqlite-schema';
const rules={thresholds:DEFAULT_THRESHOLDS,extractionInstructions:'synthetic',classificationInstructions:''};const hash=createHash('sha256').update(JSON.stringify(rules)).digest('hex');
const snapshot={versionId:`rules-1-${hash.slice(0,12)}`,contentHash:hash,createdAt:'2026-11-02T00:00:00.000Z',rules};
for(const driver of ['memory','sqlite'])describe(`task reservation ${driver}`,()=>{
 it('reserves before extraction, isolates owners, distinguishes empty results, and CASes versions',async()=>{
  const repo=driver==='sqlite'?new SqliteRepository({file:':memory:'}):new InMemoryRepository();
  try{const source=await repo.createRawSource({userId:'owner',rawText:'synthetic original',sourceType:'manual',capturedAt:'2026'});
   const plan=await repo.reserveCaptureProcessingPlan({userId:'owner',rawSourceId:source.id,rulesSnapshot:snapshot,expectedReviewRevision:0});expect(plan).toMatchObject({analysisVersion:1,extractionReady:false,rulesSnapshot:snapshot});
   await expect(repo.reserveCaptureProcessingPlan({userId:'owner',rawSourceId:source.id,rulesSnapshot:snapshot,expectedReviewRevision:0})).rejects.toMatchObject({code:'conflict'});
   await expect(repo.getCaptureProcessingPlan('foreign',source.id)).resolves.toBeNull();
   const ready=await repo.completeCaptureProcessingPlanExtraction('owner',source.id,1,[]);expect(ready.extractionReady).toBe(true);
   await repo.updateRawSourceProcessing(source.id,'owner','done');
   const attempts=await Promise.allSettled([0,1].map(()=>repo.reserveCaptureProcessingPlan({userId:'owner',rawSourceId:source.id,rulesSnapshot:snapshot,expectedReviewRevision:0,newVersion:true,expectedAnalysisVersion:1})));
   expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await repo.getCaptureProcessingPlan('owner',source.id))?.analysisVersion).toBe(2);
  }finally{if(repo instanceof SqliteRepository)await repo.close();}
 });
 it('does not let a stale task failure overwrite a newer human confirmation',async()=>{
  const repo=driver==='sqlite'?new SqliteRepository({file:':memory:'}):new InMemoryRepository();try{const source=await repo.createRawSource({userId:'owner',rawText:'Human original',sourceType:'manual',capturedAt:'2026'});await repo.reserveCaptureProcessingPlan({userId:'owner',rawSourceId:source.id,rulesSnapshot:snapshot,expectedReviewRevision:0});const node=await repo.createNode({userId:'owner',title:'Human node'});await repo.reviewSource(source.id,'owner',{actionId:'confirm',expectedRevision:0,action:'confirm',nodeId:node.id,editedText:'Human preserved content'});await repo.updateRawSourceProcessing(source.id,'owner','failed','stale task failure',0);expect(await repo.findRawSource(source.id,'owner')).toMatchObject({processingStatus:'done',reviewStatus:'confirmed',reviewRevision:1,errorReason:null});}finally{if(repo instanceof SqliteRepository)await repo.close();}
 });
});
it.each([11,12])('migration13 preserves legacy %s and rolls back its whole failed upgrade',version=>{
 const db=new DatabaseSync(':memory:');try{
  for(const step of SQLITE_MIGRATIONS.filter(s=>s.version<=version))step.apply(db);db.exec(`pragma user_version=${version}`);
  db.exec("insert into raw_sources (id,user_id,raw_text,source_type,captured_at,created_at,processing_status) values ('s','owner','original','manual','2026','2026','done');insert into capture_processing_plans values ('owner','s',1,'[]','2026','2026')");
  const before=db.prepare('select type,name,sql from sqlite_schema order by name').all();const exec=db.exec.bind(db);const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{exec(sql);if(sql.includes('rules_snapshot_json'))throw Error('synthetic migration fault');});
  expect(()=>migrateSqlite(db)).toThrow('synthetic migration fault');fault.mockRestore();expect(db.prepare('pragma user_version').get()).toEqual({user_version:version});expect(db.prepare('select type,name,sql from sqlite_schema order by name').all()).toEqual(before);
  expect(migrateSqlite(db)).toBe(13);expect(inspectSqliteLineage(db)).toMatchObject({lineage:'screenshot',userVersion:13});expect(db.prepare('select rules_snapshot_json,extraction_ready,points_json from capture_processing_plans').get()).toEqual({rules_snapshot_json:null,extraction_ready:1,points_json:'[]'});
 }finally{db.close();}
});

for (const driver of ['memory','sqlite']) describe(`review-authorized micro-commit ${driver}`,()=>{
 async function setupPoint(){
  const repo=driver==='sqlite'?new SqliteRepository({file:':memory:'}):new InMemoryRepository();const source=await repo.createRawSource({userId:'owner',rawText:'Synthetic microcommit original.',sourceType:'manual',capturedAt:'2026'});
  await repo.reserveCaptureProcessingPlan({userId:'owner',rawSourceId:source.id,rulesSnapshot:snapshot,expectedReviewRevision:0});
  await repo.completeCaptureProcessingPlanExtraction('owner',source.id,1,[{pointIndex:0,point:{text:'Synthetic point',summary:null,confidence:.9,title:'Point'},embedding:null,embeddingModel:null,decision:null,placement:null,knowledgeItemId:null,status:'pending'}]);
  const parent=await repo.createNode({userId:'owner',title:'Existing parent'});const authority={rawSourceId:source.id,expectedReviewRevision:0,analysisVersion:1,pointIndex:0,actor:'synthetic'};return{repo,source,parent,authority};
 }
 it('rolls back node/parent edge/audit together if the structural audit write fails',async()=>{
  const h=await setupPoint();try{const before={nodes:await h.repo.listNodes('owner'),edges:await h.repo.listEdges('owner'),versions:await h.repo.listVersionRecords('owner')};const internal=h.repo as unknown as {createVersionRecordSync:(input:unknown)=>unknown};const write=internal.createVersionRecordSync.bind(h.repo);internal.createVersionRecordSync=input=>{write(input);throw Error('synthetic audit commit fault');};
   await expect(h.repo.createNode({userId:'owner',title:'No half node',parentId:h.parent.id,captureAuthority:h.authority})).rejects.toThrow('synthetic audit commit fault');expect({nodes:await h.repo.listNodes('owner'),edges:await h.repo.listEdges('owner'),versions:await h.repo.listVersionRecords('owner')}).toEqual(before);
  }finally{if(h.repo instanceof SqliteRepository)await h.repo.close();}
 });
 it('rolls back item/identity and link together with their progress markers after a progress write failure',async()=>{
  const h=await setupPoint();try{const internal=h.repo as unknown as {updateCaptureProcessingPlanPointSync:(...args:unknown[])=>unknown};const update=internal.updateCaptureProcessingPlanPointSync.bind(h.repo);internal.updateCaptureProcessingPlanPointSync=(...args)=>{update(...args);throw Error('synthetic progress commit fault');};
   const before=await h.repo.getCaptureProcessingPlan('owner',h.source.id);const input={userId:'owner',rawSourceId:h.source.id,normalizedText:'Synthetic point',confidence:.9,isAiDerived:true,captureAnalysisVersion:1,capturePointIndex:0,captureAuthority:h.authority};
   await expect(h.repo.createKnowledgeItem(input)).rejects.toThrow('synthetic progress commit fault');expect(await h.repo.listKnowledgeItemsForSource(h.source.id,'owner')).toEqual([]);expect(await h.repo.getCaptureProcessingPlan('owner',h.source.id)).toEqual(before);
   internal.updateCaptureProcessingPlanPointSync=update;const item=await h.repo.createKnowledgeItem(input);const saved=await h.repo.getCaptureProcessingPlan('owner',h.source.id);expect(saved?.points[0]).toMatchObject({knowledgeItemId:item.id,status:'item_saved'});
   internal.updateCaptureProcessingPlanPointSync=(...args)=>{update(...args);throw Error('synthetic progress commit fault');};await expect(h.repo.linkItemToNode({userId:'owner',itemId:item.id,nodeId:h.parent.id,relationType:'primary',confidence:.9,captureAuthority:h.authority})).rejects.toThrow('synthetic progress commit fault');expect(await h.repo.listLinksForItem(item.id,'owner')).toEqual([]);expect(await h.repo.getCaptureProcessingPlan('owner',h.source.id)).toEqual(saved);
  }finally{if(h.repo instanceof SqliteRepository)await h.repo.close();}
 });
});
