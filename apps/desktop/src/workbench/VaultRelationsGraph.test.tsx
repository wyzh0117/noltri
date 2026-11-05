import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

describe('VaultRelationsGraph lifecycle with a synthetic renderer', () => {
  let browser: ReturnType<typeof createReviewBrowser>;
  beforeAll(async () => {
    // Bundle the actual component, replacing only the canvas/worker renderer with a lifecycle spy.
    const source = (await readFile(new URL('./VaultRelationsGraph.tsx', import.meta.url), 'utf8')).replace(
      /import \{ WorkbenchGraph \} from '\.\/WorkbenchGraph';/,
      `function WorkbenchGraph(props) { window.graphProps = props; useEffect(() => { window.graphMounts++; return () => { window.graphUnmounts++; }; }, []); return <div data-renderer="true">{props.nodes.map(node => node.title).join('|')}</div>; }`,
    );
    browser = createReviewBrowser(source + `
      import { createRoot } from 'react-dom/client';
      window.graphMounts = 0; window.graphUnmounts = 0;
      const requests = [], matches = [], opened = [];
      const api = { vaultGraph: () => new Promise((resolve, reject) => requests.push({resolve, reject})), vaultMatch: query => new Promise((resolve, reject) => matches.push({query, resolve, reject})) };
      let props = {api, rootPath:'/synthetic/one', selectedPath:'a.md', revision:0, active:false, onOpen:(path,intent)=>opened.push({path,intent})};
      const root = createRoot(document.getElementById('root'));
      function render(patch={}) { props={...props,...patch}; root.render(<VaultRelationsGraph {...props}/>); }
      const data = (title, revision=7) => ({revision,nodes:[{path:'a.md',title,basename:'a',type:'note',tags:[]},{path:'pic.png',title:'Picture',basename:'pic',type:'attachment',tags:[]},{path:'missing.md',title:'Missing',basename:'missing',type:'unresolved',tags:[]}],edges:[]});
      window.harness={render,requests,matches,opened,data,state:()=>({requests:requests.length,matches:matches.length,mounts:window.graphMounts,unmounts:window.graphUnmounts,titles:window.graphProps?.nodes.map(n=>n.title),scope:window.graphProps?.scopeIdentity,context:window.graphProps?.contextNodeId,mode:window.graphProps?.mode,loading:window.graphProps?.loading,error:window.graphProps?.error,text:document.body.textContent,hidden:document.querySelector('[aria-label="文档链接图"]')?.hidden})};
      render();
    `, fileURLToPath(new URL('.', import.meta.url)));
    await browser.start();
  }, 20_000);
  afterAll(async () => { await browser?.close(); });

  it('does not fetch inactive; mounts one renderer and labels the graph distinctly', async () => {
    await browser.until(() => browser.evaluate('harness.state()'), state => state.mounts === 1);
    expect(await browser.evaluate('harness.state().requests')).toBe(0);
    expect(await browser.evaluate('harness.state().hidden')).toBe(true);
    await browser.evaluate('harness.render({active:true})');
    await browser.until(() => browser.evaluate('harness.state().requests'), n => n === 1);
    await browser.evaluate('harness.requests[0].resolve(harness.data("A"))');
    await browser.until(() => browser.evaluate('harness.state().titles'), titles => titles.includes('A'));
    expect(await browser.evaluate('harness.state().text')).toContain('文档链接图');
    expect(await browser.evaluate('harness.state().context')).toBe('vault:a.md');
  });
  it('guards opens and maps vaultMatch paths plus attachments without semantic APIs', async () => {
    await browser.evaluate('window.graphProps.nodes.forEach(n=>window.graphProps.onNodeOpen(n,{newTab:true,split:false}))');
    expect(await browser.evaluate('harness.opened')).toEqual([{ path: 'a.md', intent: { newTab: true, split: false } }]);
    await browser.evaluate('window.queryResult=null;void window.graphProps.evaluateQuery("tag:x").then(ids=>window.queryResult=[...ids]);');
    await browser.until(() => browser.evaluate('harness.state().matches'), n => n === 1);
    await browser.evaluate('harness.matches[0].resolve({revision:7,paths:["a.md","unknown.md"],attachmentPaths:["pic.png"],matchingTags:["missing.md"]})');
    await browser.until(() => browser.evaluate('window.queryResult'), value => value !== null);
    expect(await browser.evaluate('window.queryResult')).toEqual(['vault:a.md', 'vault:pic.png']);
  });
  it('retains renderer, loaded nodes and mode while inactive, and only refreshes when active', async () => {
    await browser.evaluate('window.graphProps.onModeChange("expanded"); harness.render({active:false,revision:1});');
    await browser.until(() => browser.evaluate('harness.state().hidden'), Boolean);
    await browser.evaluate('void window.graphProps.evaluateQuery("hidden").catch(()=>{});');
    expect(await browser.evaluate('harness.state().requests')).toBe(1);
    expect(await browser.evaluate('harness.state().matches')).toBe(1);
    expect(await browser.evaluate('harness.state().titles')).toContain('A');
    await browser.evaluate('harness.render({active:true})');
    await browser.until(() => browser.evaluate('harness.state().requests'), n => n === 2);
    expect(await browser.evaluate('harness.state().mode')).toBe('expanded');
    expect(await browser.evaluate('harness.state().unmounts')).toBe(0);
  });
  it('ignores stale revision, selected path and root responses and blocks stale query results', async () => {
    await browser.evaluate('harness.render({revision:2})');
    await browser.until(() => browser.evaluate('harness.state().requests'), n => n === 3);
    await browser.evaluate('harness.requests[2].resolve(harness.data("New",8))');
    await browser.until(() => browser.evaluate('harness.state().titles'), titles => titles.includes('New'));
    await browser.evaluate('harness.requests[1].resolve(harness.data("Old"));window.queryFailure=null;void window.graphProps.evaluateQuery("pending").catch(e=>window.queryFailure=e.message);');
    await browser.until(() => browser.evaluate('harness.state().matches'), n => n === 2);
    await browser.evaluate('harness.render({selectedPath:"b.md"})');
    await browser.until(() => browser.evaluate('harness.state().requests'), n => n === 4);
    await browser.evaluate('harness.render({rootPath:"/synthetic/two"})');
    await browser.until(() => browser.evaluate('harness.state().requests'), n => n === 5);
    await browser.evaluate('harness.requests[4].resolve(harness.data("Root Two",9));harness.requests[3].resolve(harness.data("Wrong Root"));harness.matches[1].resolve({revision:8,paths:["a.md"],attachmentPaths:[],matchingTags:[]});');
    await browser.until(() => browser.evaluate('harness.state().titles'), titles => titles.includes('Root Two'));
    await browser.until(() => browser.evaluate('window.queryFailure'), Boolean);
    expect(await browser.evaluate('harness.state().titles')).not.toContain('Wrong Root');
    expect(await browser.evaluate('harness.state().context')).toBe('vault:b.md');
    expect(await browser.evaluate('harness.state().mounts')).toBe(1);
  });
  it('shows safe errors, rejects a different match revision, and ignores results arriving inactive', async () => {
    await browser.evaluate('window.queryFailure=null;void window.graphProps.evaluateQuery("mismatch").catch(e=>window.queryFailure=e.message)');
    await browser.until(() => browser.evaluate('harness.state().matches'), n => n === 3);
    await browser.evaluate('harness.matches[2].resolve({revision:10,paths:["a.md"],attachmentPaths:[],matchingTags:[]})');
    await browser.until(() => browser.evaluate('window.queryFailure'), Boolean);
    await browser.evaluate('harness.render({revision:3})');
    await browser.until(() => browser.evaluate('harness.state().requests'), n => n === 6);
    await browser.evaluate('harness.requests[5].reject(new Error("private synthetic detail"))');
    await browser.until(() => browser.evaluate('harness.state().error'), Boolean);
    expect(await browser.evaluate('harness.state().text')).not.toContain('private synthetic detail');
    await browser.evaluate('window.graphProps.onRefresh()');
    await browser.until(() => browser.evaluate('harness.state().requests'), n => n === 7);
    await browser.evaluate('harness.render({active:false})');
    await browser.until(() => browser.evaluate('harness.state().hidden'), Boolean);
    await browser.evaluate('harness.requests[6].resolve(harness.data("Late Inactive"))');
    expect(await browser.evaluate('harness.state().titles')).toContain('Root Two');
    expect(browser.errors).toEqual([]);
  });
});
