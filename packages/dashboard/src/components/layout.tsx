import type { Station } from "@orbital-js/station";
import type { AppCtx } from "../index";
import { leaveCtxRooms } from "../lib/rooms";
import { clearFlash } from "../lib/ui";

/** Keeps header nav in sync with the current URL (content swaps don't re-render main). */
const navActiveScript = `
(function () {
  if (window.__lpNavActiveBound) return;
  window.__lpNavActiveBound = true;

  function activeNavKey(path) {
    if (path === "/projects") return "projects";
    if (/\\/nodes(\\/|$)/.test(path)) return "nodes";
    if (/\\/services(\\/|$)/.test(path) || /\\/logs\\//.test(path)) return "services";
    if (path === "/" || /^\\/clusters\\/[^/]+$/.test(path)) return "clusters";
    return "clusters";
  }

  function syncNav() {
    var key = activeNavKey(location.pathname);
    document.querySelectorAll("[data-nav]").forEach(function (el) {
      var on = el.getAttribute("data-nav") === key;
      el.classList.toggle("btn-active", on);
      if (on) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
  }

  syncNav();
  window.addEventListener("popstate", syncNav);
  var content = document.getElementById("content");
  if (content) {
    new MutationObserver(syncNav).observe(content, { childList: true, subtree: false });
  }
})();
`;

/** Tail logs stay pinned to the bottom unless the user scrolls up. */
const logsAutoscrollScript = `
(function () {
  if (window.__lpLogsAutoscrollBound) return;
  window.__lpLogsAutoscrollBound = true;

  var THRESHOLD = 48;

  function nearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
  }

  function bind(el) {
    if (!el || el.hasAttribute("data-logs-bound")) return;
    el.setAttribute("data-logs-bound", "true");
    var panel = el.closest("[data-logs-panel]");
    var slot = el.closest('[p-template="logs:lines"]');
    if (slot && slot.hasAttribute("data-logs-stick")) {
      el.__lpStick = slot.getAttribute("data-logs-stick") !== "0";
    } else {
      el.__lpStick = true;
      if (slot) slot.setAttribute("data-logs-stick", "1");
    }

    function setStick(on) {
      el.__lpStick = on;
      if (slot) slot.setAttribute("data-logs-stick", on ? "1" : "0");
    }

    function syncJump() {
      var j = panel && panel.querySelector("[data-logs-jump]");
      if (!j) return;
      var show = el.scrollHeight > el.clientHeight && !nearBottom(el);
      j.classList.toggle("hidden", !show);
    }

    el.addEventListener(
      "scroll",
      function () {
        setStick(nearBottom(el));
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

  function scan() {
    document.querySelectorAll("[data-logs-autoscroll]").forEach(bind);
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-logs-jump]");
    if (!btn) return;
    var panel = btn.closest("[data-logs-panel]");
    if (!panel) return;
    var out = panel.querySelector("[data-logs-autoscroll]");
    if (!out) return;
    var slot = out.closest('[p-template="logs:lines"]');
    out.__lpStick = true;
    if (slot) slot.setAttribute("data-logs-stick", "1");
    out.scrollTop = out.scrollHeight;
    btn.classList.add("hidden");
  });

  scan();
  var content = document.getElementById("content");
  if (content) {
    new MutationObserver(scan).observe(content, { childList: true, subtree: true });
  }
})();
`;

/** Success notices fade away on their own; errors stay until dismissed. */
const noticeAutoDismissScript = `
(function () {
  if (window.__lpNoticeAutoDismissBound) return;
  window.__lpNoticeAutoDismissBound = true;

  var SUCCESS_MS = 5000;
  var timer = null;

  function sync() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    var slot = document.getElementById("notice");
    if (!slot) return;
    var form = slot.querySelector(".alert-success [data-notice-dismiss]");
    if (!form) return;
    timer = setTimeout(function () {
      form.requestSubmit();
      timer = null;
    }, SUCCESS_MS);
  }

  var slot = document.getElementById("notice");
  if (slot) {
    new MutationObserver(sync).observe(slot, { childList: true, subtree: true });
    sync();
  }
})();
`;

/** Orbital sets data-p-busy on submit buttons; mirror it to daisyUI's loading spinner. */
const busySpinnerScript = `
(function () {
  if (window.__lpBusySpinnerBound) return;
  window.__lpBusySpinnerBound = true;

  function setLoading(btn, on) {
    if (!(btn instanceof HTMLButtonElement) || !btn.classList.contains("btn")) return;
    btn.classList.toggle("loading", on);
  }

  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target.closest && e.target.closest("[p-action]");
      if (!form) return;
      var btn = form.querySelector("button[type=submit], button:not([type])");
      if (btn) setLoading(btn, true);
    },
    true
  );

  window.addEventListener("station:actionResult", function () {
    requestAnimationFrame(function () {
      document.querySelectorAll("button.btn.loading").forEach(function (btn) {
        if (!btn.hasAttribute("data-p-busy")) setLoading(btn, false);
      });
    });
  });

  new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      if (m.type === "attributes" && m.attributeName === "data-p-busy") {
        setLoading(m.target, m.target.hasAttribute("data-p-busy"));
      }
    });
  }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-p-busy"] });
})();
`;

/** Surfaces orbital WebSocket state so users know when realtime updates are paused. */
const connectionStatusScript = `
(function () {
  if (window.__lpConnectionStatusBound) return;
  window.__lpConnectionStatusBound = true;

  var banner = document.getElementById("connection-status");
  if (!banner) return;
  var msg = banner.querySelector("[data-connection-message]");

  function sync(state) {
    if (state === "open") {
      banner.classList.add("hidden");
      return;
    }
    banner.classList.remove("hidden");
    if (!msg) return;
    if (state === "reconnecting") {
      msg.textContent = "Reconnecting — realtime updates paused";
    } else if (state === "closed") {
      msg.textContent = "Disconnected — refresh the page if this persists";
    } else {
      msg.textContent = "Connecting…";
    }
  }

  window.addEventListener("station:state", function (e) {
    sync(e.detail && e.detail.state);
  });
})();
`;

/** Click a [data-copy-path] control to copy its path to the clipboard. */
const copyPathScript = `
(function () {
  if (window.__lpCopyPathBound) return;
  window.__lpCopyPathBound = true;

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

/** A [data-confirm] form shows a confirm() dialog before submitting; cancels submission if declined. */
const confirmSubmitScript = `
(function () {
  if (window.__lpConfirmSubmitBound) return;
  window.__lpConfirmSubmitBound = true;

  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target.closest && e.target.closest("[data-confirm]");
      if (!form) return;
      var message = form.getAttribute("data-confirm");
      if (message && !window.confirm(message)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
})();
`;

function NavLink({
  href,
  swap,
  label,
  nav,
}: {
  href: string;
  swap: string;
  label: string;
  nav: string;
}) {
  return (
    <a
      href={href}
      p-href={href}
      p-target="content"
      p-swap={swap}
      data-nav={nav}
      class="btn btn-ghost btn-sm lp-focus-ring"
    >
      {label}
    </a>
  );
}

function Header({ ctx }: { ctx: AppCtx }) {
  const cluster = ctx.cluster || "default";
  return (
    <header class="bg-base-300 border-b border-base-content/10">
      <div class="container mx-auto px-4 py-3 flex items-center gap-2 flex-wrap">
        <a
          href="/"
          p-href="/"
          p-target="content"
          p-swap="clusters"
          class="font-bold text-lg mr-4 lp-focus-ring rounded-md"
        >
          🚀 Launch&nbsp;Pad
        </a>
        <NavLink href="/" swap="clusters" label="Clusters" nav="clusters" />
        <NavLink href="/projects" swap="projects" label="Projects" nav="projects" />
        <NavLink href={`/clusters/${cluster}/nodes`} swap="nodes" label="Nodes" nav="nodes" />
        <NavLink
          href={`/clusters/${cluster}/services`}
          swap="services"
          label="Services"
          nav="services"
        />
        <div class="ml-auto flex items-center gap-2 text-sm opacity-70">
          <span>cluster:</span>
          <span class="badge badge-primary badge-outline">{cluster}</span>
        </div>
      </div>
    </header>
  );
}

/** Renders the per-connection notice banner (set via flash()). */
function NoticeBanner({ ctx }: { ctx: AppCtx }) {
  const n = ctx.notice;
  if (!n) return <></>;
  const cls = n.kind === "error" ? "alert-error" : "alert-success";
  return (
    <div class={`alert ${cls} my-2`} role="alert">
      <span>{n.text}</span>
      <form p-action="notice:dismiss" data-notice-dismiss>
        <button type="submit" class="btn btn-sm btn-circle btn-ghost" aria-label="Dismiss">
          ✕
        </button>
      </form>
    </div>
  );
}

export function registerLayout(station: Station<AppCtx>) {
  station.template("main", ({ ctx }) => (
    <>
      <Header ctx={ctx} />
      <div
        id="connection-status"
        data-testid="connection-status"
        class="hidden bg-warning/15 border-b border-warning/30"
        role="status"
        aria-live="polite"
      >
        <div class="container mx-auto px-4 py-2 flex items-center gap-2 text-sm">
          <span class="loading loading-spinner loading-xs text-warning"></span>
          <span data-connection-message>Connecting…</span>
        </div>
      </div>
      <div class="bg-base-100 min-h-screen">
        <div class="container mx-auto px-4 py-6">
          <div id="notice" p-template="notice"></div>
          <div id="content" p-template="clusters"></div>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: navActiveScript }} />
      <script dangerouslySetInnerHTML={{ __html: logsAutoscrollScript }} />
      <script dangerouslySetInnerHTML={{ __html: noticeAutoDismissScript }} />
      <script dangerouslySetInnerHTML={{ __html: busySpinnerScript }} />
      <script dangerouslySetInnerHTML={{ __html: connectionStatusScript }} />
      <script dangerouslySetInnerHTML={{ __html: copyPathScript }} />
      <script dangerouslySetInnerHTML={{ __html: confirmSubmitScript }} />
    </>
  ));

  station.template("notice", ({ ctx }) => <NoticeBanner ctx={ctx} />);

  station.defineAction("notice:dismiss", {
    handler: ({ ctx, invalidate }) => {
      clearFlash(ctx, invalidate);
    },
  });

  // Nav teardown: non-stream pages put p-load="room:reset" on their root so that
  // navigating away from a Monitor/Logs page tears down its shared subprocess even
  // though no socket disconnect happened. Stream pages reset-then-join in their own
  // start action instead, so they must NOT also fire this.
  station.action("room:reset", ({ ctx }) => {
    leaveCtxRooms(ctx);
  });
}
