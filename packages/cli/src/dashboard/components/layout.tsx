/**
 * Full-document HTML shell. Every page is a plain server-rendered document —
 * navigation is ordinary links, and the only client JS is three small scripts:
 * SSE fragment swapping (live monitor/logs), log autoscroll, and copy-to-clipboard.
 */
import type { Child } from "hono/jsx";

/**
 * Elements with data-sse="<url>" subscribe to an SSE endpoint whose messages are
 * JSON-encoded HTML fragments; each message replaces the element's innerHTML.
 * EventSource auto-reconnects; data-sse-state mirrors the connection for styling.
 */
const sseSwapScript = `
(function () {
  document.querySelectorAll("[data-sse]").forEach(function (el) {
    var url = el.getAttribute("data-sse");
    if (!url) return;
    var es = new EventSource(url);
    es.onmessage = function (e) {
      try {
        el.innerHTML = JSON.parse(e.data);
        el.setAttribute("data-sse-state", "open");
      } catch (err) {
        /* malformed frame — skip */
      }
    };
    es.onerror = function () {
      el.setAttribute("data-sse-state", "reconnecting");
    };
    window.addEventListener("pagehide", function () {
      es.close();
    });
  });
})();
`;

/** Tail logs stay pinned to the bottom unless the user scrolls up. */
const logsAutoscrollScript = `
(function () {
  var THRESHOLD = 48;

  function nearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
  }

  function bind(el) {
    if (!el || el.hasAttribute("data-logs-bound")) return;
    el.setAttribute("data-logs-bound", "true");
    var panel = el.closest("[data-logs-panel]");
    el.__lpStick = true;

    function syncJump() {
      var j = panel && panel.querySelector("[data-logs-jump]");
      if (!j) return;
      var show = el.scrollHeight > el.clientHeight && !nearBottom(el);
      j.classList.toggle("hidden", !show);
    }

    el.addEventListener(
      "scroll",
      function () {
        el.__lpStick = nearBottom(el);
        syncJump();
      },
      { passive: true }
    );
    new MutationObserver(function () {
      if (el.__lpStick) el.scrollTop = el.scrollHeight;
      syncJump();
    }).observe(el, { childList: true, subtree: true, characterData: true });

    if (el.__lpStick) el.scrollTop = el.scrollHeight;
    syncJump();
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-logs-jump]");
    if (!btn) return;
    var panel = btn.closest("[data-logs-panel]");
    if (!panel) return;
    var out = panel.querySelector("[data-logs-autoscroll]");
    if (!out) return;
    out.__lpStick = true;
    out.scrollTop = out.scrollHeight;
    btn.classList.add("hidden");
  });

  document.querySelectorAll("[data-logs-autoscroll]").forEach(bind);
})();
`;

/** Click a [data-copy-path] control to copy its path to the clipboard. */
const copyPathScript = `
(function () {
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-copy-path]");
    if (!btn) return;
    var path = btn.getAttribute("data-copy-path");
    if (!path) return;
    function copied() {
      if (!btn.hasAttribute("data-copy-label")) {
        btn.setAttribute("data-copy-label", btn.textContent.trim());
      }
      btn.textContent = "Copied!";
      btn.classList.add("text-success");
      window.setTimeout(function () {
        btn.textContent = btn.getAttribute("data-copy-label") || path;
        btn.classList.remove("text-success");
      }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(path).then(copied).catch(function () {});
    }
  });
})();
`;

export type NavKey =
  | "overview"
  | "clusters"
  | "projects"
  | "nodes"
  | "services"
  | "environments"
  | "none";

function NavLink({ href, label, nav, active }: { href: string; label: string; nav: NavKey; active: NavKey }) {
  const on = nav === active;
  return (
    <a
      href={href}
      data-nav={nav}
      aria-current={on ? "page" : undefined}
      class={`btn btn-ghost btn-sm lp-focus-ring${on ? " btn-active" : ""}`}
    >
      {label}
    </a>
  );
}

function Header({ cluster, active }: { cluster: string; active: NavKey }) {
  return (
    <header class="bg-base-300 border-b border-base-content/10">
      <div class="container mx-auto px-4 py-3 flex items-center gap-2 flex-wrap">
        <a href="/" class="font-bold text-lg mr-4 lp-focus-ring rounded-md">
          🚀 Launch&nbsp;Pad
        </a>
        <NavLink href="/" label="Overview" nav="overview" active={active} />
        <NavLink href="/clusters" label="Clusters" nav="clusters" active={active} />
        <NavLink href="/projects" label="Projects" nav="projects" active={active} />
        <NavLink href={`/clusters/${cluster}/nodes`} label="Nodes" nav="nodes" active={active} />
        <NavLink href={`/clusters/${cluster}/services`} label="Services" nav="services" active={active} />
        <NavLink
          href={`/clusters/${cluster}/environments`}
          label="Environments"
          nav="environments"
          active={active}
        />
        <div class="ml-auto flex items-center gap-2 text-sm opacity-70">
          <span class="badge badge-ghost badge-outline">read-only</span>
          <span>cluster:</span>
          <span class="badge badge-primary badge-outline">{cluster}</span>
        </div>
      </div>
    </header>
  );
}

export function Layout({
  title,
  cluster,
  active,
  children,
}: {
  title: string;
  cluster: string;
  active: NavKey;
  children?: Child;
}) {
  return (
    <html lang="en" data-theme="night">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title ? `${title} · Launch Pad` : "Launch Pad"}</title>
        <link rel="stylesheet" href="/dashboard.css" />
      </head>
      <body>
        <Header cluster={cluster} active={active} />
        <div class="bg-base-100 min-h-screen">
          <div class="container mx-auto px-4 py-6">
            <div id="content">{children}</div>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: sseSwapScript }} />
        <script dangerouslySetInnerHTML={{ __html: logsAutoscrollScript }} />
        <script dangerouslySetInnerHTML={{ __html: copyPathScript }} />
      </body>
    </html>
  );
}
