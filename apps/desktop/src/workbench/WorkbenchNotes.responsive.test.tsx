import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

const css = ['workbench.css', 'notes-workbench.css'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const harness = `
let frame;
const paint=()=>new Promise(resolve=>frame.contentWindow.requestAnimationFrame(()=>frame.contentWindow.requestAnimationFrame(resolve)));
window.harness={
 async mount(width,split){
  frame?.remove();frame=document.createElement('iframe');frame.style.width=width+'px';frame.style.height='760px';frame.style.border='0';document.body.append(frame);
  const doc=frame.contentDocument;doc.open();doc.write('<!doctype html><html><head></head><body></body></html>');doc.close();
  const style=doc.createElement('style');style.textContent=${JSON.stringify(css)};doc.head.append(style);
  const shell=doc.createElement('div');shell.className='library-shell library-shell-notes library-shell-graph-mini';shell.style.setProperty('--graph-panel-width','300px');
  shell.innerHTML='<aside class="library-sidebar" data-navigation-mode="subjects"><nav class="sidebar-function-rail" aria-label="快速操作"><button>快速切换</button></nav><nav class="sidebar-mode-tabs" role="tablist" aria-label="知识导航方式"><button role="tab">学科与方向</button><button role="tab">搜索</button></nav><div class="sidebar-tree-head">学科与方向</div><nav class="subject-tree" aria-label="学科知识树">Topic</nav></aside><main class="library-main notes-workspace-main"><section class="vault-notes"><main class="vault-note-main"><div class="vault-editor-layout'+(split?' has-split':'')+'"><section class="vault-editor-column">正文</section>'+(split?'<section class="vault-split-column">分屏</section>':'')+'</div></main></section></main><aside class="graph-panel graph-panel-mini" aria-label="Graph 面板">关系</aside>';
  doc.body.append(shell);await paint();
 },
 state(){
  const doc=frame.contentDocument,view=frame.contentWindow,shell=doc.querySelector('.library-shell-notes'),main=doc.querySelector('.notes-workspace-main'),sidebar=doc.querySelector('.library-sidebar'),graph=doc.querySelector('.graph-panel'),editor=doc.querySelector('.vault-editor-layout');
  const shellStyle=view.getComputedStyle(shell),editorStyle=view.getComputedStyle(editor),cols=style=>style.gridTemplateColumns;
  const columnCount=value=>value==='none'?0:value.split(/\\s+/).length;
  return {viewport:view.innerWidth,shellDisplay:shellStyle.display,shellColumns:shellStyle.display==='grid'?columnCount(cols(shellStyle)):0,sidebarWidth:sidebar.getBoundingClientRect().width,mainWidth:main.getBoundingClientRect().width,graphWidth:graph.getBoundingClientRect().width,graphHeight:graph.getBoundingClientRect().height,editorColumns:columnCount(cols(editorStyle)),tablistDisplay:view.getComputedStyle(doc.querySelector('[role=tablist]')).display,treeDisplay:view.getComputedStyle(doc.querySelector('.subject-tree')).display,graphIsShellSibling:graph.parentElement===shell,legacyNestedGraph:doc.querySelector('.vault-relations-graph')!==null};
 }
};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('../..', import.meta.url)));
interface LayoutState {
  viewport: number;
  shellDisplay: string;
  shellColumns: number;
  sidebarWidth: number;
  mainWidth: number;
  graphWidth: number;
  graphHeight: number;
  editorColumns: number;
  tablistDisplay: string;
  treeDisplay: string;
  graphIsShellSibling: boolean;
  legacyNestedGraph: boolean;
}
const state = () => browser.evaluate<LayoutState>('window.harness.state()');

describe('unified Notes shell responsive layout', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());

  it.each([780, 821, 1100])('keeps one outer navigation and Graph rail at %ipx', async (width) => {
    await browser.evaluate(`window.harness.mount(${width},false)`);
    const actual = await state();
    expect(actual.viewport).toBe(width);
    expect(actual.shellDisplay).toBe('grid');
    expect(actual.shellColumns).toBe(3);
    expect(actual.sidebarWidth).toBeGreaterThan(160);
    expect(actual.mainWidth).toBeGreaterThan(0);
    expect(actual.graphWidth).toBeCloseTo(300, 0);
    expect(actual.graphIsShellSibling).toBe(true);
    expect(actual.legacyNestedGraph).toBe(false);
    expect(actual.editorColumns).toBe(1);
    expect(actual.tablistDisplay).not.toBe('none');
    expect(actual.treeDisplay).not.toBe('none');
    expect(browser.errors).toEqual([]);
  });

  it('stacks the right rail on narrow screens and collapses editor split columns', async () => {
    await browser.evaluate('window.harness.mount(520,true)');
    const actual = await state();
    expect(actual.shellDisplay).toBe('block');
    expect(actual.shellColumns).toBe(0);
    expect(actual.sidebarWidth).toBeCloseTo(520, 0);
    expect(actual.mainWidth).toBeGreaterThan(0);
    expect(actual.graphWidth).toBeCloseTo(520, 0);
    expect(actual.graphHeight).toBeGreaterThan(80);
    expect(actual.editorColumns).toBe(1);
    expect(actual.graphIsShellSibling).toBe(true);
    expect(actual.legacyNestedGraph).toBe(false);
    expect(actual.tablistDisplay).not.toBe('none');
    expect(actual.treeDisplay).not.toBe('none');
    expect(browser.errors).toEqual([]);
  });
});
