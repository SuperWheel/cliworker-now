// Local placement for the native Modal/Input and independent name-copy action.
export const renameCopyStyles = `
.cwn-rename-dialog{padding-bottom:16px;gap:12px}
.cwn-rename-content>:first-child{padding-top:16px;padding-bottom:8px}
.cwn-rename-content>:last-child{margin-top:12px}
.cwn-rename-form{display:flex;flex-direction:column;gap:12px;min-width:0;width:100%}
.cwn-rename-form>.cwn-rename-input{display:flex;box-sizing:border-box;width:100%;min-width:0}
.cwn-rename-input>input{width:100%;min-width:0}
.cwn-rename-form>p{margin:0;font-size:var(--dsw-font-xxs-12-font-size);color:var(--dsw-alias-label-tertiary);line-height:20px}
.cwn-rename-error{font-size:var(--dsw-font-xxs-12-font-size);line-height:20px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.cwn-rename-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.cwn-name-copy{min-width:0;max-width:38%;display:inline-flex;position:relative;flex-shrink:1}
.cwn .cwn-worker-name{display:inline-flex;align-items:center;flex:1;max-width:none;min-width:0;gap:0;border:0;border-radius:var(--dsw-radius-sm);padding:2px 8px;margin:0 -4px;background:transparent;color:inherit;font:inherit;user-select:text;transition:background-color .1s,color .1s}
.cwn-worker-name>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cwn-name-divider{display:block;width:1px;height:12px;background:currentColor;flex:none}
.cwn-worker-meta>.cwn-worker-model{margin-inline-start:4px}
.cwn .cwn-worker-name:hover,.cwn .cwn-worker-name:focus-visible{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cwn-name-copy-failure{position:absolute;top:100%;left:0;z-index:1;max-width:260px;width:max-content;padding:4px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:normal}
@media(prefers-reduced-motion:reduce){.cwn-worker-name{transition:none!important}}
`
