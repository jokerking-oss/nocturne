/**
 * 诊断脚本：把 NOCTURNE 页面里的 worker 通信记到 window.__ncLog，
 * 然后由外部轮询读取。不改动产品代码。
 */
(function () {
  if (window.__ncInstalled) return;
  window.__ncInstalled = true;
  window.__ncLog = [];

  const OrigWorker = window.Worker;
  window.Worker = function (url, opts) {
    let w;
    try {
      w = new OrigWorker(url, opts);
    } catch (e) {
      window.__ncLog.push('THROW ' + (e && e.message));
      throw e;
    }
    window.__ncWorker = w;
    window.__ncLog.push('SPAWN ' + String(url));

    const origPost = w.postMessage.bind(w);
    w.postMessage = function (m) {
      window.__ncLog.push('OUT ' + JSON.stringify(m).slice(0, 120));
      return origPost(m);
    };
    w.addEventListener('message', (e) => {
      const t = e.data && e.data.type;
      const extra =
        t === 'download' && e.data.data
          ? ' ' + (e.data.data.file || '') + ' @' + Math.round(e.data.data.progress || 0)
          : '';
      window.__ncLog.push('IN ' + t + extra);
    });
    w.addEventListener('error', (e) => {
      window.__ncLog.push('ERR ' + (e && e.message ? e.message : 'unknown'));
    });
    return w;
  };

  window.addEventListener('error', (e) => window.__ncLog.push('PAGEERR ' + e.message));
  window.addEventListener('unhandledrejection', (e) =>
    window.__ncLog.push('REJECT ' + String(e.reason))
  );
})();
