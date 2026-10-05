/**
 * Pages Chrome will not let an extension read or write, expressed as data in / a reason out.
 *
 * §10.4 asks for the opposite of a silent failure: a restricted page has to say *why* nothing
 * happened and hand the user a path they operate themselves, because a pill that simply never
 * appears reads as a broken product.
 */

export type RestrictedReason =
  | 'browser_page'
  | 'web_store'
  | 'pdf_viewer'
  | 'other_extension'
  | 'local_file'
  | 'unsupported_scheme';

const BROWSER_PREFIXES = ['chrome://', 'chrome-search://', 'edge://', 'brave://', 'opera://', 'vivaldi://', 'about:', 'devtools://', 'view-source:'];
const WEB_STORE_HOSTS = ['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com', 'addons.mozilla.org'];
/** The PDF viewer is an extension page in Chrome and Firefox alike; its text lives in a plugin, not the DOM. */
const PDF_VIEWER_HOSTS = ['mhjfbmdgcfjbbpaeojofohoefgiehjai', 'pdfjs-viewer'];

export interface RestrictedPageInfo {
  readonly reason: RestrictedReason;
  readonly message: string;
  /** What the user can do instead, phrased as their own action — the extension never touches the clipboard for them. */
  readonly fallback: string;
}

const MESSAGE: Readonly<Record<RestrictedReason, string>> = {
  browser_page: '浏览器内部页面不允许扩展读取选区',
  web_store: '扩展商店页面禁止任何扩展注入',
  pdf_viewer: 'PDF 由浏览器插件渲染，扩展拿不到文本',
  other_extension: '其它扩展的页面不允许注入',
  local_file: '未授予本地文件访问权限',
  unsupported_scheme: '该地址协议不在采集范围内',
};

const FALLBACK = '复制这段文字，在知序 Noltri 弹窗的粘贴框里收纳。';

export function restrictedReasonForHref(href: string): RestrictedReason | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return 'unsupported_scheme';
  }
  const scheme = url.protocol.toLowerCase();
  // The store is an ordinary https:// page, so this has to be checked before https is declared allowed,
  // or a web-store page would get a pill that Chrome then refuses to inject.
  if (scheme === 'https:' && WEB_STORE_HOSTS.includes(url.hostname.toLowerCase())) return 'web_store';
  if (scheme === 'http:' || scheme === 'https:') return undefined;
  if (scheme === 'file:') return 'local_file';
  if (scheme === 'chrome-extension:' || scheme === 'moz-extension:' || scheme === 'extension:') {
    return isPdfViewer(url) ? 'pdf_viewer' : 'other_extension';
  }
  if (BROWSER_PREFIXES.some((prefix) => href.trim().toLowerCase().startsWith(prefix))) return 'browser_page';
  if (scheme === 'data:' || scheme === 'blob:') return 'unsupported_scheme';
  return 'unsupported_scheme';
}

function isPdfViewer(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (PDF_VIEWER_HOSTS.includes(host)) return true;
  return url.pathname.toLowerCase().includes('pdf');
}

/**
 * A restricted page never gets the pill, so the only copy the user sees is this one — it has to name
 * the cause and the way out, and it must not be a generic 「未连接」 that would send them to Settings.
 */
export function describeRestrictedPage(info: RestrictedPageInfo): string {
  return `${info.message}。${info.fallback}`;
}

export function restrictionOf(href: string): RestrictedPageInfo | undefined {
  const reason = restrictedReasonForHref(href);
  if (reason === undefined) return undefined;
  return { reason, message: MESSAGE[reason], fallback: reason === 'local_file' ? '在扩展设置中允许「访问文件 URL」后再试，或复制文字用粘贴框收纳。' : FALLBACK };
}
