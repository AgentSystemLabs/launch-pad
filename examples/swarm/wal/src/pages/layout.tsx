import type { Station } from "@orbital-js/station";
import type { Database } from "bun:sqlite";
import type { AppCtx } from "../lib/ctx.ts";
import { getControl } from "../db/queries.ts";

/** Status pill reflecting paused / running / idle. */
function StatusPill({ paused, state }: { paused: boolean; state: string }) {
  const label = paused ? "paused" : state;
  const cls = paused ? "badge-warning" : state === "running" ? "badge-success" : "badge-ghost";
  return <span class={`badge ${cls} badge-lg font-semibold uppercase tracking-wide`}>{label}</span>;
}

export function registerLayout(station: Station<AppCtx>, db: Database) {
  // The document shell. Station injects this into <div id="main">; the route
  // for the current path swaps the #content region's template.
  station.template("main", () => (
    <>
      <div class="navbar bg-base-200 border-b border-base-300 px-4 sticky top-0 z-20">
        <div class="flex-1 flex items-center gap-4">
          <a href="/" p-href="/" p-target="content" class="text-lg font-bold">
            🛰️ Swarm
          </a>
          <nav class="flex gap-1" data-nav>
            <a href="/" p-href="/" p-target="content" class="btn btn-ghost btn-sm" data-nav-link="/">
              Dashboard
            </a>
            <a
              href="/timeline"
              p-href="/timeline"
              p-target="content"
              class="btn btn-ghost btn-sm"
              data-nav-link="/timeline"
            >
              WAL
            </a>
          </nav>
        </div>
        <div class="flex-none">
          <div id="control-bar" p-template="control-bar"></div>
        </div>
      </div>

      <div id="connection-status" class="hidden bg-warning/20 border-b border-warning/40 px-4 py-1 text-sm">
        <span data-connection-message>Connecting…</span>
      </div>

      <main class="container mx-auto max-w-6xl px-4 py-6">
        <div id="notice" p-template="notice"></div>
        <div id="content" p-template="dashboard"></div>
      </main>

      <script
        dangerouslySetInnerHTML={{
          __html: `
          // Highlight the active nav link.
          (function(){
            function sync(){
              var p = location.pathname;
              document.querySelectorAll('[data-nav-link]').forEach(function(a){
                var href = a.getAttribute('data-nav-link');
                a.classList.toggle('btn-active', href === p);
              });
            }
            window.addEventListener('popstate', sync);
            window.addEventListener('station:welcome', sync);
            document.addEventListener('click', function(){ setTimeout(sync, 0); });
            sync();
          })();
          // Connection status banner.
          (function(){
            var bar = document.getElementById('connection-status');
            var msg = bar ? bar.querySelector('[data-connection-message]') : null;
            window.addEventListener('station:state', function(e){
              if(!bar) return;
              var s = e.detail && e.detail.state;
              if(s === 'open'){ bar.classList.add('hidden'); }
              else { bar.classList.remove('hidden'); if(msg) msg.textContent = s === 'reconnecting' ? 'Reconnecting…' : (s === 'closed' ? 'Disconnected' : 'Connecting…'); }
            });
          })();
          // Keep stdout / feed panes pinned to the bottom on update.
          (function(){
            var obs = new MutationObserver(function(){
              document.querySelectorAll('[data-autoscroll]').forEach(function(el){
                el.scrollTop = el.scrollHeight;
              });
            });
            obs.observe(document.body, { childList: true, subtree: true });
          })();
        `,
        }}
      />
    </>
  ));

  station.template("control-bar", ({ ctx }) => {
    const c = getControl(db);
    return (
      <div class="flex items-center gap-3">
        <StatusPill paused={c.paused} state={c.state} />
        {c.paused ? (
          <button class="btn btn-success btn-sm" p-click-action="swarm:resume">
            Resume
          </button>
        ) : (
          <button class="btn btn-warning btn-sm" p-click-action="swarm:pause">
            Pause
          </button>
        )}
      </div>
    );
  });

  station.template("notice", ({ ctx }) => {
    if (!ctx.notice) return <></>;
    const cls = ctx.notice.kind === "error" ? "alert-error" : "alert-success";
    return (
      <div class={`alert ${cls} mb-4`} role="alert">
        <span>{ctx.notice.text}</span>
        <button class="btn btn-ghost btn-xs" p-click-action="notice:dismiss">
          ✕
        </button>
      </div>
    );
  });

  station.action("notice:dismiss", ({ ctx, invalidate }) => {
    ctx.notice = null;
    invalidate("notice");
  });
}
