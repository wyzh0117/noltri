import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

// A graph-only multi-column rule overriding the <=820px collapse must fail these cases.
// These iframe viewports load the production cascade without grid/display fixture overrides.
const css = ['workbench.css', 'notes-workbench.css'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const harness = `
let frame;
const paint=()=>new Promise(resolve=>frame.contentWindow.requestAnimationFrame(()=>frame.contentWindow.requestAnimationFrame(resolve)));
window.harness={
 async mount(width,shape,hasGraph){
  frame?.remove();frame=document.createElement('iframe');frame.style.width=width+'px';frame.style.height='640px';frame.style.border='0';document.body.append(frame);
  const doc=frame.contentDocument;doc.open();doc.write('<!doctype html><html><head></head><body></body></html>');doc.close();
  const style=doc.createElement('style');style.textContent=${JSON.stringify(css)};doc.head.append(style);
  const empty=shape==='empty',split=shape==='split';
  const layout=empty?'vault-empty-layout':'vault-editor-layout panel-'+(hasGraph?'graph':'outline')+(split?' has-split':'');
  const primary=empty?'<div class="vault-empty-note"><h1>Synthetic empty note</h1></div>':'<section class="vault-editor-column">Synthetic source</section>';
  const secondary=split?'<section class="vault-split-column">Synthetic split source</section>':'';
  const sidebar=(!empty||hasGraph)?'<aside class="vault-organize-panel">'+(hasGraph?'<div class="vault-relations-graph"><aside class="graph-panel graph-panel-mini"><div class="workbench-graph">Synthetic graph slot</div></aside></div>':'Synthetic outline')+'</aside>':'';
  doc.body.innerHTML='<div class="library-shell-notes"><section class="vault-notes"><aside class="vault-file-sidebar">Synthetic files</aside><main class="vault-note-main"><div class="'+layout+(hasGraph?' has-relations-graph':'')+'">'+primary+secondary+sidebar+'</div></main></section></div>';
  await paint();
 },
 async graphWidth(width){frame.contentDocument.documentElement.style.setProperty('--graph-panel-width',width+'px');await paint();},
 state(){
  const doc=frame.contentDocument,view=frame.contentWindow;
  const layout=doc.querySelector('.vault-editor-layout,.vault-empty-layout'),primary=layout.firstElementChild,split=doc.querySelector('.vault-split-column'),sidebar=doc.querySelector('.vault-organize-panel'),graph=doc.querySelector('.graph-panel');
  const style=view.getComputedStyle(layout),columns=style.gridTemplateColumns;
  return {viewport:view.innerWidth,display:style.display,columns:columns==='none'?[]:columns.split(/\\s+/).map(parseFloat),width:layout.getBoundingClientRect().width,primaryWidth:primary.getBoundingClientRect().width,splitWidth:split?.getBoundingClientRect().width,sidebarDisplay:sidebar?view.getComputedStyle(sidebar).display:null,sidebarWidth:sidebar?.getBoundingClientRect().width??0,sidebarHeight:sidebar?.getBoundingClientRect().height??0,graphWidth:graph?.getBoundingClientRect().width??0,graphHeight:graph?.getBoundingClientRect().height??0};
 }
};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('../..', import.meta.url)));
interface LayoutState {
  viewport: number;
  display: string;
  columns: number[];
  width: number;
  primaryWidth: number;
  splitWidth?: number;
  sidebarDisplay: string | null;
  sidebarWidth: number;
  sidebarHeight: number;
  graphWidth: number;
  graphHeight: number;
}
const fixtures = [
  { shape: 'normal', graph: true, wideColumns: 2 },
  { shape: 'split', graph: true, wideColumns: 3 },
  { shape: 'empty', graph: true, wideColumns: 2 },
  { shape: 'normal', graph: false, wideColumns: 2 },
  { shape: 'split', graph: false, wideColumns: 3 },
  { shape: 'empty', graph: false, wideColumns: 0 },
] as const;
const state = () => browser.evaluate<LayoutState>('window.harness.state()');
async function mount(width: number, shape: string, graph: boolean): Promise<LayoutState> {
  await browser.evaluate(`window.harness.mount(${width},${JSON.stringify(shape)},${graph})`);
  return state();
}

describe('production Notes responsive relationship columns', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());

  it.each(fixtures)('fills the narrow $shape body with graph=$graph when the sidebar is hidden', async ({ shape, graph }) => {
    for (const width of [780, 820, 560]) {
      const actual = await mount(width, shape, graph);
      expect(actual.viewport).toBe(width);
      expect(actual.sidebarDisplay).toBe(shape === 'empty' && !graph ? null : 'none');
      expect(actual.sidebarWidth).toBe(0);
      expect(actual.columns, JSON.stringify(actual)).toHaveLength(shape === 'empty' && !graph ? 0 : 1);
      expect(Math.abs(actual.primaryWidth - actual.width), JSON.stringify(actual)).toBeLessThan(1);
      if (shape === 'split') expect(Math.abs(actual.splitWidth! - actual.width), JSON.stringify(actual)).toBeLessThan(1);
    }
    expect(browser.errors).toEqual([]);
  });

  it.each(fixtures)('preserves wide $shape columns and sidebar with graph=$graph', async ({ shape, graph, wideColumns }) => {
    for (const width of [821, 1100]) {
      const actual = await mount(width, shape, graph);
      expect(actual.viewport).toBe(width);
      expect(actual.columns, JSON.stringify(actual)).toHaveLength(wideColumns);
      expect(actual.sidebarDisplay).toBe(shape === 'empty' && !graph ? null : 'flex');
      if (wideColumns === 0) {
        expect(Math.abs(actual.primaryWidth - actual.width)).toBeLessThan(1);
      } else {
        expect(actual.sidebarWidth).toBeGreaterThan(180);
        expect(actual.primaryWidth).toBeLessThan(actual.width - 180);
      }
      if (graph) {
        expect(Math.abs(actual.graphWidth - actual.sidebarWidth)).toBeLessThan(2);
        expect(actual.graphHeight).toBeGreaterThan(80);
        expect(actual.graphHeight).toBeLessThanOrEqual(actual.sidebarHeight + 1);
      }
    }
    expect(browser.errors).toEqual([]);
  });

  it.each(['normal', 'split', 'empty'])('retains the wide graph width variable for the %s layout', async (shape) => {
    await mount(1100, shape, true);
    await browser.evaluate('window.harness.graphWidth(280)');
    const before = await state();
    await browser.evaluate('window.harness.graphWidth(360)');
    const after = await state();
    expect(before.sidebarWidth).toBeCloseTo(280, 0);
    expect(after.sidebarWidth).toBeCloseTo(360, 0);
    expect(after.graphWidth - before.graphWidth).toBeCloseTo(80, 0);
    expect(after.primaryWidth).toBeLessThan(before.primaryWidth);
    expect(browser.errors).toEqual([]);
  });
});
