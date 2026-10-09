// Management additions retain the host Menu, Tooltip, theme and motion primitives.
export const workerManagementStyles = `
.cwn-worker{display:block;padding:12px;min-height:62px}
.cwn .cwn-worker-menu-anchor{display:block;width:100%}
.cwn-worker-layout{display:grid;grid-template-columns:minmax(0,1fr) 14px;column-gap:10px;align-items:center;min-width:0}
.cwn-worker-open{display:flex;align-items:center;gap:10px;width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit}
.cwn-worker-open{grid-column:1;grid-row:1}.cwn-worker-open>.cwn-worker-line{flex:1;min-width:0}
.cwn-worker-layout>.cwn-worker-meta{grid-column:1;grid-row:2}
.cwn-worker-chevron{grid-column:2;grid-row:1/span 2;align-self:center;display:grid;place-items:center;color:var(--cwn-muted);pointer-events:none}.cwn-worker-chevron>svg{display:block;width:14px;height:14px}
.cwn-worker-menu{z-index:1100}
.cwn-archived-list{display:grid;gap:8px}.cwn-archived-row{display:flex;gap:8px;align-items:center;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}.cwn-archived-row>div{min-width:0;flex:1}.cwn-archived-row strong,.cwn-archived-row small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cwn-archived-row small{color:var(--cwn-muted);margin-top:3px}
.cwn-filter-row{display:flex;align-items:center;gap:6px;margin:10px 0 14px;min-width:0}.cwn-filter-row .cwn-filters{flex:1;min-width:0;margin:0}
.cwn .cwn-archive-toggle{width:var(--cwn-control-height,36px);min-width:var(--cwn-control-height,36px);height:var(--cwn-control-height,36px);min-height:var(--cwn-control-height,36px);flex:none;padding:0;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md)}.cwn-archive-toggle svg{width:16px;height:16px}.cwn .cwn-archive-toggle:hover:not([aria-pressed=true]){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}.cwn .cwn-archive-toggle[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,#000);color:#fff}.cwn .cwn-archive-toggle[aria-pressed=true]:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 75%,#000);color:#fff}
.cwn-resume-banner{display:flex;align-items:center;gap:8px;flex:none;min-width:0;margin:0 16px 8px;padding:4px 8px 4px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);color:var(--cwn-muted);font-size:12px;line-height:20px}.cwn-resume-banner>span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cwn .cwn-resume-banner button{flex:none;height:24px;min-height:24px;padding:0 8px;font-size:12px}
.cwn-start-empty{height:100%;min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 12px}.cwn-start-empty h3{margin:0 0 8px;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary);text-wrap:balance}.cwn-start-empty p{max-width:360px;margin:0;font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary);text-wrap:balance}
`
