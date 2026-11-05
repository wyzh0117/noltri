import { expect, it } from 'vitest';
import { createApplicationUpdateGuard } from './application-update-guard';
it('blocks local drafts before any Core read and requires a known idle Core', async () => {
 let calls=0;
 expect(await createApplicationUpdateGuard(()=>false,async()=>{calls++;return 0;})()).toBe(false);
 expect(calls).toBe(0);
 for(const count of [1,-1,NaN,Infinity]) expect(await createApplicationUpdateGuard(()=>true,async()=>count)()).toBe(false);
 expect(await createApplicationUpdateGuard(()=>true,async()=>{throw Error('synthetic unavailable');})()).toBe(false);
 expect(await createApplicationUpdateGuard(()=>true,async()=>0)()).toBe(true);
});
it('rechecks drafts or work that starts while the Core preflight is pending', async () => {
 let safe=true,release!:()=>void;
 const guard=createApplicationUpdateGuard(()=>safe,async()=>{await new Promise<void>(r=>{release=r;});return 0;});
 const pending=guard();safe=false;release();expect(await pending).toBe(false);
});
