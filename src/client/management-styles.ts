// Management additions retain the host Menu, Tooltip, theme and motion primitives.
export const workerManagementStyles = `
.cwn-worker{display:block;padding:12px;min-height:62px}
.cwn-worker-open{display:flex;align-items:center;gap:10px;width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit}
.cwn-worker-open>.cwn-worker-line{flex:1;min-width:0}.cwn-worker-open>svg{width:14px;height:14px;color:var(--cwn-muted)}
.cwn-worker-meta{margin-top:5px}.cwn-name-copy{min-width:0;max-width:38%;display:inline-flex;position:relative;flex-shrink:1}
.cwn .cwn-worker-name{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;border:0;border-radius:var(--dsw-radius-sm);padding:1px 3px;margin:0;background:transparent;color:inherit;font:inherit;user-select:text;transition:background-color .1s,color .1s}
.cwn-worker-name>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cwn-worker-name>svg{width:13px;height:13px;opacity:0;flex-shrink:0;transition:opacity .1s}
.cwn .cwn-worker-name:hover,.cwn .cwn-worker-name:focus-visible{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cwn-worker-name:hover>svg,.cwn-worker-name:focus-visible>svg,.cwn-worker-name[data-copied=true]>svg{opacity:1}.cwn-name-copy-failure{position:absolute;top:100%;left:0;z-index:1;max-width:260px;width:max-content;padding:4px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:normal}
.cwn .cwn-worker-manage{width:22px;height:22px;padding:3px;margin-left:3px;color:var(--cwn-muted)}.cwn-worker-meta>span:has(.cwn-worker-manage){margin-left:auto;flex-shrink:0}
.cwn-worker-menu{z-index:1100}.cwn-management-nav{display:flex;justify-content:flex-end;margin:-5px 0 6px}.cwn .cwn-management-nav button{font-size:12px;color:var(--cwn-muted)}
.cwn-archived-list{display:grid;gap:8px}.cwn-archived-row{display:flex;gap:8px;align-items:center;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}.cwn-archived-row>div{min-width:0;flex:1}.cwn-archived-row strong,.cwn-archived-row small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cwn-archived-row small{color:var(--cwn-muted);margin-top:3px}
.cwn-resume-block{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 4px 8px;color:var(--cwn-muted);font-size:12px;line-height:18px}.cwn-resume-block span{min-width:0}.cwn-resume-block button{flex-shrink:0}.cwn-new-conversation{display:flex;align-items:center;justify-content:space-between;font-size:12px;margin:0 4px 8px;color:var(--cwn-muted)}
@media(prefers-reduced-motion:reduce){.cwn-worker-name,.cwn-worker-name>svg{transition:none!important}}
`
