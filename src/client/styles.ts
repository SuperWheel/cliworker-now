// Harness 0.2.0-rc.2 typography/radius/elevation tokens are inherited live.
// Native md Button defines the 36px control height in Harness 0.2.0-rc.2.
// Input has no size variant, so its wrapper shares that height here.
// Conversation text uses the same host font-size preference as the main composer.
export const styles = `
.cwn,.cwn-settings-dialog,.cwn-rename-dialog{--cwn-control-height:36px}
.cwn-control-input{height:var(--cwn-control-height,36px)}
.cwn{position:relative;--cwn-accent:var(--dsw-alias-state-business-primary);--cwn-muted:var(--dsw-alias-label-tertiary);--cwn-border:var(--dsw-alias-border-l3);display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);container-type:inline-size}
.cwn *{box-sizing:border-box}.cwn svg{flex-shrink:0}.cwn select,.cwn textarea{font-family:inherit}.cwn-worker,.cwn-cli-heading{font:inherit}.cwn button{cursor:pointer}.cwn button:disabled{cursor:default;opacity:.45}.cwn button:focus-visible,.cwn summary:focus-visible,.cwn input:focus-visible,.cwn textarea:focus-visible,.cwn select:focus-visible{outline:2px solid var(--cwn-accent);outline-offset:2px}
.cwn-brand{display:inline-flex;position:relative;flex-shrink:0;vertical-align:middle}.cwn-brand img{display:block;width:100%;height:100%;object-fit:contain}.cwn-brand .cwn-icon-dark{display:none}body[data-ds-dark-theme] .cwn-brand .cwn-icon-mono{filter:invert(1)}body[data-ds-dark-theme] .cwn-brand .cwn-icon-light{display:none}body[data-ds-dark-theme] .cwn-brand .cwn-icon-dark{display:block}
.cwn-project-logo{display:block;position:relative;width:100%;height:100%;mask-size:contain;mask-position:center;mask-repeat:no-repeat;mask-mode:alpha;-webkit-mask-size:contain;-webkit-mask-position:center;-webkit-mask-repeat:no-repeat}.cwn-project-logo.monochrome{background:#000}body[data-ds-dark-theme] .cwn-project-logo.monochrome{background:#fff}
.cwn-head{display:flex;align-items:center;gap:9px;min-height:56px;padding:10px 16px;flex-shrink:0}.cwn-head h2{flex:1;min-width:0;font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cwn-back{width:28px!important;padding:0!important;flex-shrink:0}.cwn-settings-button{width:36px!important;padding:0!important;flex-shrink:0;align-self:center}.cwn-settings-button svg{display:block}.cwn-back{border-radius:var(--dsw-radius-md)!important;background:var(--dsw-alias-interactive-bg-hover)!important}
.cwn-wordmark{display:flex;align-items:center;gap:6px;min-width:0;flex:1;height:36px}.cwn-wordmark h2{display:flex;align-items:center;gap:10px;overflow:visible!important;font-family:var(--dsw-font-family);font-size:21px!important;line-height:28px!important;font-weight:500;letter-spacing:normal}.cwn-wordmark h2 small{display:inline-flex;align-items:center;justify-content:center;height:18px;padding:0 5px;border-radius:3px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2);font-size:10px;line-height:14px;font-weight:600;letter-spacing:.08em}.cwn-overview{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding-top:4px}.cwn-overview-controls{flex:none;min-width:0;padding:0 14px}.cwn-overview-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px 14px 20px}.cwn-search{width:100%}

.cwn-filters{display:flex;gap:6px;margin:10px 0 14px}.cwn-filters button{flex:1;min-width:0;padding:0 7px;background:var(--dsw-alias-interactive-bg-hover)!important}.cwn-filters button[aria-pressed=true]{color:var(--cwn-accent)!important;border-color:var(--cwn-border)!important;background:color-mix(in srgb,var(--cwn-accent) 10%,transparent)!important}.cwn-filter-info{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:var(--dsw-font-xxs-12-font-size);color:var(--cwn-muted);margin:0 0 10px}
.cwn-cli-group{border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);margin:0 0 12px;overflow:hidden}.cwn-cli-heading{display:flex;align-items:center;gap:9px;width:100%;min-height:45px;padding:10px 12px;border:0;background:transparent;color:inherit;text-align:left}.cwn-cli-heading strong{font-size:var(--dsw-font-s-14-font-size);font-weight:600;flex:1;min-width:0}.cwn-cli-heading>span:not(.cwn-brand){font-size:var(--dsw-font-xxs-12-font-size);color:var(--cwn-muted);white-space:nowrap}.cwn-cli-heading>svg{width:12px;height:12px;color:var(--cwn-muted);transform:rotate(90deg);transition:transform var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease)}.cwn-cli-heading[aria-expanded=false]>svg{transform:none}.cwn-cli-heading[aria-expanded=true]{border-bottom:.5px solid var(--dsw-alias-border-l2)}
.cwn-cli-rows{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease),opacity var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease),visibility var(--ds-transition-duration,.2s)}.cwn-cli-rows[data-expanded=false]{grid-template-rows:0fr;opacity:0;visibility:hidden}.cwn-cli-rows-inner{min-height:0;overflow:hidden}
@media(prefers-reduced-motion:reduce){.cwn-cli-rows,.cwn-cli-heading>svg,.cwn-cli-heading:after{transition:none!important}}
.cwn-worker{display:flex;width:100%;align-items:center;gap:10px;padding:12px;background:transparent;color:inherit;border:0;text-align:left;min-height:62px;position:relative}.cwn-worker+.cwn-worker:before{content:'';position:absolute;left:12px;right:12px;top:0;height:.5px;background:var(--dsw-alias-border-l2)}.cwn-worker:hover,.cwn-worker:focus-visible{background:color-mix(in srgb,var(--cwn-accent) 9%,transparent)}.cwn-worker>svg{width:14px;height:14px;color:var(--cwn-muted)}.cwn-worker-content{flex:1;min-width:0}.cwn-worker-line{display:flex;align-items:center;gap:8px;min-width:0}.cwn-worker-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsw-font-s-14-font-size);font-weight:500}.cwn-worker-status{display:inline-flex;align-items:center;gap:5px;font-size:var(--dsw-font-xxs-12-font-size);white-space:nowrap;flex-shrink:0;color:var(--cwn-muted)}.cwn-dot{display:inline-block;flex-shrink:0;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}.cwn-worker-status.running{color:var(--cwn-accent)}.cwn-dot.running{background:var(--cwn-accent)}.cwn-worker-status.completed{color:var(--dsw-alias-state-success-primary)}.cwn-dot.completed{background:var(--dsw-alias-state-success-primary)}.cwn-worker-status.failed{color:var(--dsw-alias-state-error-primary)}.cwn-dot.failed{background:var(--dsw-alias-state-error-primary)}.cwn-worker-status.queued,.cwn-worker-status.stopping{color:var(--dsw-alias-state-warn-label)}.cwn-dot.queued,.cwn-dot.stopping{background:var(--dsw-alias-state-warn-primary)}.cwn-worker-meta{display:flex;align-items:center;gap:7px;margin-top:5px;color:var(--cwn-muted);font-size:var(--dsw-font-xxs-12-font-size);min-width:0}.cwn-worker-meta>.cwn-worker-name,.cwn-worker-meta>.cwn-worker-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cwn-worker-meta>span:last-child{flex-shrink:0;white-space:nowrap}.cwn-worker-name{max-width:38%}.cwn-worker-model{flex:0 1 auto}.cwn-meta-divider{opacity:.5;flex-shrink:0}
.cwn-actions{position:relative}.cwn-actions>summary{display:flex;width:28px;height:28px;align-items:center;justify-content:center;list-style:none;border-radius:var(--dsw-radius-md);cursor:pointer}.cwn-actions>summary::-webkit-details-marker{display:none}.cwn-actions>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}.cwn-action-menu{position:absolute;right:0;top:34px;width:240px;max-width:calc(100cqw - 32px);z-index:5;padding:12px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--cwn-border);border-radius:var(--dsw-radius-lg);--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-panel);font-size:var(--dsw-font-xxs-12-font-size);overflow-wrap:anywhere}.cwn-action-menu p{color:var(--cwn-muted);margin:8px 0;font-size:var(--dsw-font-xxs-12-font-size)}.cwn-action-menu>button{display:flex;margin-top:8px}
.cwn-feed{flex:1;overflow:auto;overscroll-behavior:contain;min-height:60px;padding:18px 16px}.cwn-message{width:100%;margin:0 0 22px}.cwn-message.user{width:fit-content;max-width:85%;margin-left:auto}.cwn-message.user .cwn-text{padding:10px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-bubble,var(--dsw-alias-interactive-bg-hover))}.cwn-message-label{position:relative;display:flex;justify-content:flex-end;color:var(--cwn-muted);font-size:var(--dsw-font-xxs-12-font-size);margin-bottom:6px}.cwn-message.assistant .cwn-message-label{justify-content:flex-start}.cwn-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:calc(24px + var(--dsh-content-font-delta,0px));font-size:var(--dsh-content-font-size,14px)}.cwn-tool{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);margin:8px 0;background:var(--dsw-alias-interactive-bg-hover);font-size:var(--dsw-font-xxs-12-font-size)}.cwn-tool summary{display:flex;align-items:center;gap:7px;padding:10px;cursor:pointer;list-style:none}.cwn-tool summary::-webkit-details-marker{display:none}.cwn-tool summary:before{content:'›';color:var(--cwn-muted)}.cwn-tool[open] summary:before{transform:rotate(90deg)}.cwn-tool-title{min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.cwn-tool small{font-size:var(--dsw-font-xxs-12-font-size);color:var(--cwn-muted);max-width:38%;overflow-wrap:anywhere}.cwn-tool pre{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-xxs-12-font-size)/1.6 var(--ds-font-family-code,monospace);margin:0;padding:0 12px 12px;max-height:320px;overflow:auto}.cwn-status{font-size:var(--dsw-font-xxs-12-font-size);color:var(--cwn-muted);text-align:center;margin:16px 0}
.cwn-compose{padding:8px 12px 12px;flex-shrink:0}.cwn-compose-state{display:flex;align-items:center;gap:6px;font-size:var(--dsw-font-xxs-12-font-size);color:var(--cwn-muted);margin:0 4px 7px}.cwn-compose-box{padding:10px;border:0;border-radius:var(--dsw-radius-panel);--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-soft);background:var(--dsw-specific-input-major,var(--dsw-alias-interactive-bg-hover))}.cwn .cwn-compose textarea:focus-visible{outline:none}.cwn-compose textarea{display:block;width:100%;height:45px;min-height:45px;max-height:140px;resize:vertical;border:0;padding:0 2px;background:transparent;color:inherit;line-height:calc(24px + var(--dsh-content-font-delta,0px));font-size:var(--dsh-content-font-size,14px);outline:none}.cwn-compose textarea::placeholder{color:var(--cwn-muted)}.cwn-compose textarea:disabled{opacity:.6}.cwn-compose-bottom{display:flex;align-items:center;gap:8px;margin-top:6px;min-height:30px}.cwn-compose-model{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cwn-muted);font-size:var(--dsw-font-xxs-12-font-size)}.cwn-send{width:30px!important;height:30px!important;padding:0!important;border-radius:50%!important;flex-shrink:0}.cwn-resume-hint{font-size:var(--dsw-font-xxs-12-font-size);line-height:1.6;color:var(--cwn-muted);margin:0 4px 8px}
.cwn-settings{padding:12px 16px;display:grid;gap:9px;overflow:auto;max-height:65%;flex-shrink:0;border-bottom:.5px solid var(--cwn-border)}.cwn-settings label{font-size:var(--dsw-font-xxs-12-font-size);display:grid;gap:5px}.cwn-settings select{width:100%;border:.5px solid var(--cwn-border);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:inherit;padding:7px;font-size:var(--dsw-font-s-14-font-size)}.cwn-settings p{font-size:var(--dsw-font-xxs-12-font-size);color:var(--cwn-muted);line-height:1.6;margin:0}
.cwn-empty{padding:30px 10px;text-align:center;color:var(--cwn-muted);line-height:1.8}.cwn-empty h3{color:var(--dsw-alias-label-primary);font-weight:500;font-size:var(--dsw-font-s-14-font-size);margin:12px 0}.cwn-empty p{font-size:var(--dsw-font-xxs-12-font-size)}.cwn-empty blockquote{margin:12px 0;padding:12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-interactive-bg-hover);font-size:var(--dsw-font-xxs-12-font-size);text-align:left}.cwn-notice,.cwn-error{font-size:var(--dsw-font-xxs-12-font-size);padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);line-height:1.6;overflow-wrap:anywhere;margin:8px 12px;max-height:180px;overflow:auto;flex-shrink:0}.cwn-error{color:var(--dsw-alias-state-error-primary)}.cwn-error button{margin:8px 0}.cwn-error details{font-size:var(--dsw-font-xxs-12-font-size)}.cwn-error summary{cursor:pointer}
.cwn-history-nav{border-bottom:.5px solid var(--cwn-border);padding:10px 16px;font-size:var(--dsw-font-xxs-12-font-size);flex-shrink:0}.cwn-history-nav>div{display:flex;gap:5px;flex-wrap:wrap;margin:7px 0}.cwn-history-nav small{color:var(--cwn-muted)}.cwn-history-start{display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:var(--dsw-font-xxs-12-font-size);margin:0 0 16px;color:var(--cwn-muted)}.cwn-jump{display:flex;justify-content:center;padding:4px 12px 8px}.cwn-copy{display:inline-flex;align-items:center;gap:6px;margin-top:5px;max-width:100%}.cwn-copy button{color:var(--cwn-muted)}.cwn-copy-feedback{font-size:var(--dsw-font-xxs-12-font-size);overflow-wrap:anywhere;color:var(--cwn-muted)}.cwn-sr-only{position:absolute;top:0;left:0;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@container (max-width:320px){.cwn-head{padding:10px 12px}.cwn-overview-controls{padding:0 10px}.cwn-overview-list{padding:8px 10px 10px}.cwn-worker-line{gap:5px}.cwn-worker-status{font-size:var(--dsw-font-xxs-12-font-size)}.cwn-worker-meta{gap:5px}.cwn-filters{gap:4px}.cwn-filters button{padding:0 4px!important}.cwn-feed{padding:14px 12px}}
`

// Geometry below mirrors Harness 0.2.0-rc.2 chat/composer and sidebar New Session.
export const nativeChatStyles = `
.cwn-entry{width:24px!important;height:24px!important;min-width:24px;padding:3px!important;border-radius:var(--dsw-radius-sm)!important;flex-shrink:0;background:transparent!important;border:0!important;box-shadow:none!important}
.cwn-entry:hover{background:var(--dsw-alias-interactive-bg-hover)!important}
.cwn .cwn-search{height:var(--cwn-control-height);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}
.cwn .cwn-search:focus-within{outline:none;box-shadow:none;border-color:var(--dsw-alias-border-l3)}
.cwn .cwn-search input:focus-visible{outline:none;box-shadow:none}
.cwn .cwn-search input::placeholder{color:var(--dsw-alias-label-caption)}
.cwn-back,.cwn-settings select,.cwn-tool{border:.5px solid var(--dsw-alias-border-l3)}
.cwn-cli-group{--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-soft)}
body[data-ds-dark-theme] .cwn-cli-group{box-shadow:var(--dsw-elevation-stroke),0 4px 12px #00000040,0 12px 24px -8px #00000059}
.cwn-feed{padding:16px 24px}
.cwn-message{margin-bottom:24px}
.cwn-message.user{max-width:82%}
.cwn-message.user .cwn-text{padding:10px 16px;border-radius:var(--dsw-radius-xl);line-height:calc(22px + var(--dsh-content-font-delta,0px))}
.cwn-message-label{height:28px;margin:6px 0 0;gap:8px;align-items:center;font-size:var(--dsh-content-font-size-secondary,13px);line-height:24px}
.cwn-message.assistant .cwn-message-label{margin-top:16px;margin-left:-6px}
.cwn-markdown{min-width:0;overflow-wrap:anywhere}
.cwn-copy{margin:0;position:relative}
.cwn-copy .cwn-copy-icon{width:28px;height:28px;padding:6px;color:var(--dsw-alias-label-tertiary)}
.cwn-status{text-align:left;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:8px 0;margin:8px 0 16px;font-size:var(--dsh-content-font-size-secondary,13px)}
.cwn-compose{padding:0 16px 4px}
.cwn-compose-box{display:flex;flex-direction:column;gap:12px;padding:8px 0 0}
.cwn-compose textarea{resize:none;height:36px;min-height:36px;max-height:336px;padding:4px 12px 0 14px;overflow-y:auto;margin:0;box-sizing:border-box}
.cwn-compose textarea::placeholder{color:var(--dsw-alias-label-caption)}
.cwn-compose-bottom{justify-content:flex-end;gap:8px;padding:2px 8px 6px;margin:0;min-height:42px}
.cwn-model-menu{margin-left:auto;min-width:0;max-width:calc(100% - 42px)}
.cwn .cwn-compose-model{display:flex;align-items:center;gap:6px;height:28px;max-width:100%;padding:0 8px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm)}
.cwn-compose-model>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}
.cwn-model-effort{flex-shrink:0;color:var(--dsw-alias-label-tertiary)}
.cwn .cwn-send{corner-shape:round!important;width:34px!important;height:34px!important;border:0!important;border-radius:999px!important;background:var(--dsw-alias-button-info-fill)!important;color:#fff!important;display:grid;place-items:center;transform:translateY(-2px)}
.cwn .cwn-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)!important}
.cwn .cwn-send:disabled{opacity:.4}
.cwn-compose-state{height:24px;gap:8px;margin:4px 8px 0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}
.cwn-compose-cli{margin-left:auto}
@container(max-width:320px){.cwn-feed{padding:14px 16px}.cwn-compose{padding-left:8px;padding-right:8px}.cwn-model-effort{display:none}}
`

export const modelPickerStyles = `
.cwn-progress{margin:12px 0 16px;padding-bottom:12px;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size,14px);line-height:22px}
.cwn-progress>summary{display:flex;gap:6px;align-items:center;cursor:pointer;list-style:none}.cwn-progress>summary::-webkit-details-marker{display:none}.cwn-progress-chevron{display:inline-flex;transform:rotate(90deg)}.cwn-progress-chevron svg{width:12px;height:12px}.cwn-progress[open] .cwn-progress-chevron{transform:rotate(-90deg)}
.cwn-process-body{padding-top:12px;display:grid;gap:8px}.cwn-process-note{margin:0;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-tertiary)}.cwn-process-event{font-size:var(--dsh-content-font-size-secondary,13px)}

.cwn-model-popover{width:max-content;min-width:min(240px,calc(100vw - 32px));max-width:min(420px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));padding:4px;color:var(--dsw-alias-label-primary);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent)}
.cwn-model-popover button[role=menuitem]{min-height:34px;padding:5px 7px;font-size:13px;font-weight:400;line-height:20px;border-radius:var(--dsw-radius-md)}
.cwn-model-cell{display:flex;align-items:center;gap:6px;width:100%;min-width:0}.cwn-model-cell>span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cwn-model-cell-value{color:var(--dsw-alias-label-tertiary);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px}
.cwn-model-search{background:transparent!important;border:0!important;box-shadow:none!important;padding:5px 7px!important;margin:2px 0 3px;height:auto!important}.cwn-model-search input{font-size:12px!important;padding:0!important}.cwn-model-provider,.cwn-model-feedback{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:8px}.cwn-model-feedback{max-width:280px;white-space:normal}
/* Scope to plugin buttons, including the portaled menu and header entry. */
.cwn button,.cwn-entry,.cwn-model-popover button{border:0!important;--dsw-elevation-stroke-color:transparent;box-shadow:none}
.cwn-cli-heading{position:relative}.cwn-cli-heading:after{content:'';position:absolute;bottom:0;left:0;right:0;height:.5px;background:var(--dsw-alias-border-l2);pointer-events:none;opacity:0;transition:opacity var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease)}.cwn-cli-heading[aria-expanded=true]:after{opacity:1}
.cwn-back:hover:not(:disabled),.cwn-filters button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)!important}
.cwn-filters button[aria-pressed=true]:hover:not(:disabled){background:color-mix(in srgb,var(--cwn-accent) 18%,transparent)!important}
.cwn-cli-heading:hover:not(:disabled),.cwn-model-popover button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cwn button:focus-visible,.cwn-entry:focus-visible,.cwn-model-popover button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.cwn button,.cwn-entry,.cwn-model-popover button{transition:none}}

.cwn .cwn-send{padding:0;min-width:34px;min-height:34px;flex:none}.cwn .cwn-send svg{width:16px;height:16px}
`

export const telemetryStyles = `
.cwn-stat{display:inline-flex;align-items:center;gap:6px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;padding:1px 8px;min-width:0;transition:background-color 180ms ease,color 180ms ease}
.cwn-stat>span{overflow:hidden;text-overflow:ellipsis}.cwn-stat:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cwn-message-label time{white-space:nowrap;flex-shrink:0}.cwn-message-label .cwn-usage{padding-left:0}.cwn-message-label{gap:6px}
.cwn-telemetry{margin:4px 0 0;gap:0;justify-content:space-between}.cwn-telemetry .cwn-usage{flex:1;justify-content:center}.cwn-run-stat{max-width:35%}.cwn-context{flex-shrink:0}
.cwn-context-track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2}.cwn-context-fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2;stroke-linecap:round}



@media(prefers-reduced-motion:reduce){.cwn-stat,.cwn summary{transition:none}}
@container(max-width:360px){.cwn-message-label{flex-wrap:wrap;height:auto;min-height:28px}.cwn-message-label time{margin-left:0}.cwn-telemetry .cwn-stat{padding-left:4px;padding-right:4px;gap:4px}}
`

// Pinned to Harness 0.2.0-rc.2: WorkStatus, MessageIconActions, StatsPills,
// TurnUsagePanel, ContextMeter and ModelSelect. Native Tooltip/Menu own animations.
export const nativeInteractionStyles = `
.cwn-progress{padding-bottom:0;border:0}.cwn-progress>summary{height:calc(33px + var(--dsh-content-font-delta,0px));width:100%;padding:0 0 8px;border-radius:0;border-bottom:.5px solid var(--dsw-alias-border-l2);transition:color .1s;line-height:calc(24px + var(--dsh-content-font-delta,0px));gap:4px}.cwn-progress>summary:hover{color:var(--dsw-alias-label-secondary);background:transparent}.cwn-progress-chevron{transition:transform .1s}.cwn-progress-chevron svg{width:14px;height:14px}
.cwn-message-label{height:calc(28px + var(--dsh-content-font-delta,0px));gap:8px}.cwn-message-label time{line-height:calc(24px + var(--dsh-content-font-delta,0px))}.cwn-message.assistant .cwn-message-label time{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px)}
.cwn-copy .cwn-copy-icon{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary)}.cwn-copy-icon svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}.cwn-message.assistant .cwn-copy-icon svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}.cwn-copy .cwn-copy-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cwn-stat-anchor{min-width:0;display:inline-flex}.cwn-telemetry{gap:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}.cwn-telemetry>.cwn-stat-anchor:nth-child(2){flex:1;justify-content:center}
.cwn-stat{font:inherit;line-height:inherit;transition:none}.cwn-stat:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}.cwn button.cwn-stat{background:transparent;cursor:pointer}.cwn button.cwn-stat:hover,.cwn button.cwn-stat[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cwn-telemetry .cwn-usage{border-radius:999px;corner-shape:round;padding:1px 8px;gap:6px}.cwn-message-label .cwn-stat-anchor{margin-left:8px}.cwn-message-label .cwn-reply-usage{height:calc(28px + var(--dsh-content-font-delta,0px));font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);padding:6px 8px;gap:4px}.cwn-reply-usage svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}.cwn button.cwn-reply-usage:hover,.cwn button.cwn-reply-usage[aria-expanded=true]{color:var(--dsw-alias-label-tertiary)}
.cwn-context{border-radius:var(--dsw-radius-sm);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));padding:1px 8px;gap:6px}
.cwn-stat-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}
.cwn-stat-title{color:var(--dsw-alias-label-primary);display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500}.cwn-stat-title>span{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}.cwn-stat-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}.cwn-stat-details{color:var(--dsw-alias-label-tertiary);display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0}.cwn-stat-details dt,.cwn-stat-details dd{min-width:0;margin:0}.cwn-stat-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.cwn-context-panel{width:min(264px,100vw - 24px);min-width:0;padding:12px;line-height:20px}.cwn-context-header{display:flex;align-items:center;gap:6px}.cwn-context-header strong{margin-left:auto;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap}.cwn-context-bar{height:4px;margin:10px 0 12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;corner-shape:round;overflow:hidden}.cwn-context-bar>span{display:block;height:100%;min-width:2px;background:var(--dsw-alias-label-tertiary)}.cwn-context-source{margin:0 0 8px;color:var(--dsw-alias-label-tertiary)}
.cwn .cwn-compose-model{gap:4px;padding:0 4px 0 8px;max-width:min(360px,45cqw);font-size:13px;line-height:20px}.cwn .cwn-model-effort{color:var(--dsw-alias-label-caption);flex-shrink:1000;min-width:0;overflow:hidden;text-overflow:ellipsis}.cwn-model-chevron{color:var(--dsw-alias-label-caption);transition:transform .12s}.cwn-compose-model[aria-expanded=true] .cwn-model-chevron{transform:rotate(180deg)}.cwn-model-popover button:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}
@media(prefers-reduced-motion:reduce){.cwn-progress>summary,.cwn-progress-chevron,.cwn-model-chevron{transition:none}}
`

// Deliberate user preference: soft hover transitions also on neutral/disabled controls.
export const hoverFeedbackStyles = `
.cwn button,.cwn summary,.cwn-entry,.cwn-model-popover button{transition:background-color 180ms ease,color 180ms ease,opacity 180ms ease}
.cwn button:disabled{pointer-events:auto}
.cwn button:disabled:not(.cwn-send):hover{background:var(--dsw-alias-interactive-bg-hover)!important;color:var(--dsw-alias-label-secondary)}
.cwn .cwn-send:disabled:hover{background:var(--dsw-alias-button-info-hover)!important}
/* On white, hover-solid and the neutral resting fill look identical. Use the
   stronger host active token for a visible neutral hover, retaining the fade. */
body:not([data-ds-dark-theme]) .cwn-back:hover:not(:disabled),
body:not([data-ds-dark-theme]) .cwn-filters button:not([aria-pressed=true]):hover:not(:disabled),
body:not([data-ds-dark-theme]) .cwn button:disabled:not(.cwn-send):hover{background:var(--dsw-alias-interactive-bg-active)!important}
@media(prefers-reduced-motion:reduce){.cwn button,.cwn summary,.cwn-entry,.cwn-model-popover button{transition:none}}
`

// Harness 0.2.0-rc.2 ui-chat: ChatView / MessageIconActions module styles.
// These private components are not exported; public icons and theme tokens are
// reused. Native jump has no transition, and history actions fade in 80ms.
export const conversationInteractionStyles = `
.cwn-conversation{position:relative;flex:1;min-height:60px;display:flex;flex-direction:column}
.cwn-jump{z-index:8;height:0;padding:0;padding-right:max(calc(var(--dsh-composer-side-clearance,16px) + 16px),calc((100% - var(--dsh-chat-content-width,100%))/2));pointer-events:none;justify-content:flex-end;display:flex;position:absolute;bottom:16px;left:0;right:0}
.cwn .cwn-jump-button{--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);corner-shape:round;width:34px;height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-floating-fill);box-shadow:var(--dsw-elevation-panel);cursor:pointer;pointer-events:auto;border:0;border-radius:100px;justify-content:center;align-items:center;margin-top:-34px;padding:0;display:flex;transition:none}
.cwn .cwn-jump-button:hover{background:var(--dsw-alias-button-floating-hover)}
.cwn-message-label button{transition:none}
@media(hover:hover){
.cwn [data-actions-reveal=hover] .cwn-message-label{opacity:0;transition:opacity 80ms}
.cwn [data-actions-reveal=hover]:hover .cwn-message-label,.cwn [data-actions-reveal=hover]:focus-within .cwn-message-label{opacity:1}
}
`

export const settingsStyles = `
.cwn-settings-dialog{width:min(800px,90vw);max-width:90vw;height:700px;max-height:100%}
.cwn-settings-content{padding-top:4px!important;min-height:0;flex:1;overflow:hidden}
.cwn-settings-content>div:last-child{flex:1;min-height:0}.cwn-settings-content>div:first-child{flex-shrink:0}
.cwn-settings-layout{display:grid;grid-template-columns:188px minmax(0,1fr);gap:24px;height:100%;min-height:0;font-family:var(--dsw-font-family);font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height);color:var(--dsw-alias-label-primary)}
.cwn-settings-layout *{box-sizing:border-box}
.cwn-settings-nav{display:flex;flex-direction:column;gap:6px;align-self:stretch;min-height:0;overflow:auto;overscroll-behavior:contain}.cwn-settings-nav>button{flex-shrink:0}
.cwn-settings-nav button{justify-content:flex-start;gap:10px;width:100%;font-weight:400}
.cwn-settings-nav button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}
.cwn-settings-nav-primary{padding:0 12px!important}
.cwn-settings-nav-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0}
.cwn-settings-nav-primary[aria-expanded]{margin-top:6px}
.cwn-settings-nav-chevron{display:inline-flex;margin-left:auto;transition:transform 220ms cubic-bezier(.2,0,0,1)}
.cwn-settings-nav-primary[aria-expanded=false] .cwn-settings-nav-chevron{transform:rotate(-90deg)}
.cwn-settings-cli-group{display:grid;grid-template-rows:1fr;opacity:1;flex-shrink:0;transition:grid-template-rows 220ms cubic-bezier(.2,0,0,1),opacity 180ms ease,visibility 220ms}
.cwn-settings-cli-group[data-expanded=false]{grid-template-rows:0fr;opacity:0;visibility:hidden}
.cwn-settings-cli-group-inner{display:flex;flex-direction:column;gap:4px;min-height:0;overflow:hidden;padding-left:14px}
.cwn-settings-cli-group-inner>button{flex-shrink:0;padding:0 10px!important}
.cwn-settings-nav-label{flex:1;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cwn-settings-nav-status{width:14px;height:14px;display:flex;align-items:center;justify-content:center;flex:none}
.cwn-connection-dot{display:block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.cwn-connection-dot[data-state=connected]{background:var(--dsw-alias-state-success-primary)}
.cwn-connection-dot[data-state=failed]{background:var(--dsw-alias-state-error-primary)}
.cwn-settings-nav button[data-enabled=false],.cwn-cli-identity[data-enabled=false] .cwn-settings-cli-name{color:var(--dsw-alias-label-caption)}
.cwn-settings-nav button[data-enabled=false] .cwn-brand,.cwn-cli-identity[data-enabled=false] .cwn-brand{filter:grayscale(1);opacity:.5}
.cwn-settings-pane{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 2px 8px 0}
.cwn-cli-identity,.cwn-settings-cli-name,.cwn-cli-toggle,.cwn-settings-section-tools{display:flex;align-items:center;gap:10px}
.cwn-cli-identity{justify-content:space-between;min-height:60px;padding:4px 0 0}
.cwn-settings-cli-name{gap:14px}.cwn-settings-cli-name h2{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.02em}.cwn-cli-subtitle{margin:4px 0 0;font-size:var(--dsw-font-xxs-12-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary)}
.cwn-cli-toggle-status{height:20px;overflow:auto;margin:4px 0 4px;font-size:var(--dsw-font-xxs-12-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary)}
.cwn-section-progress{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none}
.cwn-settings-section{min-width:0}.cwn-settings-section+.cwn-settings-section{margin-top:20px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l2)}
.cwn-settings-section-head,.cwn-account-terminal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;min-height:36px}
.cwn-settings-section-head h3{font-size:inherit;font-weight:500;margin:0}
.cwn-settings-form{display:flex;flex-direction:column;gap:0}.cwn-settings-form label{display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-secondary)}
.cwn-settings-choice{display:block;width:min(240px,48%);min-width:0;flex-shrink:0}.cwn-settings-choice>button{width:100%;justify-content:space-between;gap:12px;background:var(--dsw-alias-interactive-bg-hover)}.cwn-settings-choice>button>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cwn-settings-choice-menu{width:min(300px,85vw);min-width:min(220px,85vw);max-width:min(300px,85vw);max-height:300px;overflow:auto}
.cwn-settings-hint,.cwn-settings-feedback,.cwn-account-summary,.cwn-account-instruction{margin:0;font-size:var(--dsw-font-xxs-12-font-size);line-height:20px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.cwn-account-row{display:flex;align-items:center;gap:12px;min-height:56px}.cwn-account-summary{display:flex;align-items:center;flex:1;min-width:0;min-height:52px;margin:0;color:var(--dsw-alias-label-secondary)}
.cwn-account-status-line{display:flex;align-items:center;min-width:0;gap:8px;min-height:24px;font-size:var(--dsw-font-s-14-font-size);line-height:22px}.cwn-account-login{display:inline-flex;align-items:center;gap:6px;min-width:0}.cwn-account-login:not([data-state=failed]){flex-shrink:0;white-space:nowrap}.cwn-account-login[data-state=connected]{color:var(--dsw-alias-state-success-primary)}.cwn-account-login[data-state=failed]{color:var(--dsw-alias-state-error-primary)}.cwn-account-login[data-state=disabled]{color:var(--dsw-alias-label-caption)}.cwn-account-status-dot{display:inline-block;flex-shrink:0;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}.cwn-account-status-dot[data-state=connected]{background:var(--dsw-alias-state-success-primary)}.cwn-account-status-dot[data-state=failed]{background:var(--dsw-alias-state-error-primary)}.cwn-account-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.cwn-settings-notice{min-height:20px;max-height:56px;overflow:auto;margin:8px 0 0}.cwn-settings-notice:empty{min-height:0;height:0;margin:0}
.cwn-settings-form .cwn-setting-row{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}.cwn-setting-row-text{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;font-size:var(--dsw-font-s-14-font-size);line-height:22px}.cwn-setting-description{font-size:var(--dsw-font-xxs-12-font-size);line-height:18px;color:var(--dsw-alias-label-tertiary)}.cwn-settings-save{margin-top:16px;justify-content:flex-end}
.cwn-settings-feedback-slot{min-height:20px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.cwn-account-summary[data-provider-logins=true] .cwn-account-status-line{width:100%}.cwn-account-summary[data-provider-logins=true] .cwn-account-login{flex-shrink:1}.cwn-account-logins{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cwn-settings-feedback,.cwn-settings-save,.cwn-account-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cwn-account-actions{min-height:36px;flex-shrink:0;justify-content:flex-end;gap:8px}.cwn-account-actions button{background:transparent}.cwn-account-logout{flex-shrink:0;gap:5px!important;padding:0 8px!important;color:var(--dsw-alias-state-error-primary)!important}.cwn-account-logout:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)!important}.cwn-refresh{width:36px!important;padding:0!important}.cwn-account-login-action,.cwn-account-manage{padding:0 10px!important}
.cwn-local-loading,.cwn-loading{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxs-12-font-size);line-height:20px}
/* Native md Button owns the 36px height; native Switch keeps its own 36x20px geometry. */
.cwn-settings-choice-menu button{border:0;box-shadow:none;--dsw-elevation-stroke-color:transparent}.cwn-settings-layout button:not([role=switch]),.cwn-settings-choice-menu button{transition:background-color 180ms ease,color 180ms ease,opacity 180ms ease}
.cwn-account-actions button:hover:not(:disabled),.cwn-settings-section-head button:hover:not(:disabled),.cwn-settings-nav button:hover:not(:disabled),.cwn-account-terminal-head button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cwn-settings-nav button[aria-pressed=true]:hover,.cwn-settings-choice>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.cwn-settings-layout button:not([role=switch]):disabled{pointer-events:auto}
.cwn-settings-layout button:not([role=switch]):disabled:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-secondary)}
.cwn-settings-layout button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.cwn-account-terminal{margin-top:16px;padding:12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);min-width:0}
.cwn-account-terminal-head{margin-bottom:8px}.cwn-account-terminal-head strong{font-size:12px;font-weight:500}.cwn-account-terminal-view{height:300px;min-height:200px;margin:12px 0;overflow:hidden}.cwn-account-terminal-view .xterm{height:100%}.cwn-account-terminal-view .xterm-viewport{background-color:var(--dsw-alias-bg-layer-2)!important}.cwn-account-terminal-view .xterm-helper-textarea{resize:none!important;min-height:0!important;max-height:0!important}
.cwn-native-model-settings>p{margin:0 0 16px;color:var(--dsw-alias-label-secondary);font-size:var(--cwn-font-sm);line-height:1.6}.cwn-account-dialog{width:min(720px,90vw);max-width:90vw}.cwn-account-dialog-content{min-height:0;overflow:auto}.cwn-account-dialog .cwn-account-terminal{margin:0;padding:0;border:0;background:transparent}.cwn-account-dialog .cwn-account-terminal-view{height:300px;max-height:48vh}.cwn-account-dialog .cwn-account-terminal button{border:0!important;transition:background-color 180ms ease,color 180ms ease}.cwn-account-dialog .cwn-account-terminal button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
/* OMP onboarding needs room for its native header and provider list. Small screens scroll the modal body. */
.cwn-account-dialog .cwn-account-terminal[data-cli="omp"] .cwn-account-terminal-view{height:520px;max-height:none}
@media(max-width:640px){.cwn-account-row{flex-wrap:wrap}.cwn-account-actions{margin-left:auto}.cwn-settings-content{overflow:auto}.cwn-settings-layout{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);gap:16px}.cwn-settings-nav{max-height:190px}.cwn-settings-cli-group-inner{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.cwn-settings-nav button{min-width:0}.cwn-settings-pane{overflow:auto}.cwn-settings-form .cwn-setting-row{gap:12px}.cwn-setting-description{max-width:180px}.cwn-account-terminal-view{height:240px}}
@media(prefers-reduced-motion:reduce){.cwn-settings-layout button,.cwn-settings-choice-menu button,.cwn-settings-nav-chevron,.cwn-settings-cli-group{transition:none}}
`

export const rolePresetStyles = `
.cwn-roles-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0 20px}
.cwn-roles-heading h2{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.02em}
.cwn-roles-heading p{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-s-14-font-size);line-height:22px}
.cwn-roles-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:18px}.cwn-roles-toolbar>span{flex:1;min-width:0}.cwn-roles-toolbar>button{flex-shrink:0}
.cwn-role-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;min-height:160px;align-content:start}
.cwn-role-card{min-width:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.cwn-role-card>button{display:flex;flex-direction:column;gap:7px;width:100%;height:100%;min-height:104px;padding:16px;text-align:left;background:transparent;color:inherit;font:inherit;border:0;cursor:pointer}
.cwn-role-card>button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cwn-role-card-heading{display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;min-width:0}.cwn-role-card-heading strong{font-size:var(--dsw-font-s-14-font-size);font-weight:500;overflow-wrap:anywhere}.cwn-role-card-heading svg{width:12px;height:12px;color:var(--dsw-alias-label-tertiary);flex-shrink:0;transform:rotate(90deg)}
.cwn-role-card-summary{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;font-size:var(--dsw-font-xxs-12-font-size);line-height:20px;color:var(--dsw-alias-label-tertiary)}
.cwn-role-editor{display:flex;flex-direction:column;gap:16px}.cwn-role-back{align-self:flex-start}.cwn-role-editor label{display:flex;flex-direction:column;gap:8px;min-width:0}.cwn-role-editor textarea{display:block;width:100%;min-height:240px;resize:vertical;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:12px;font:inherit;line-height:1.65;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cwn-role-editor textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.cwn-role-editor-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.cwn-role-editor-actions>.cwn-role-delete{margin-right:auto}.cwn-role-delete{background:var(--dsw-alias-state-error-primary)!important;color:#fff!important}.cwn-role-delete:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,#000)!important}.cwn-role-delete-confirm>button+button{margin-left:8px}
.cwn-role-delete-confirm{padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}.cwn-role-delete-confirm p{margin:0 0 8px;font-size:var(--dsw-font-xxs-12-font-size)}
.cwn-role-feedback{min-height:22px;margin-top:12px;font-size:var(--dsw-font-xxs-12-font-size);line-height:20px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}.cwn-role-feedback[role=alert]{color:var(--dsw-alias-state-error-primary)}.cwn-role-empty{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-s-14-font-size)}
.cwn-rename-dialog{width:min(420px,90vw);max-width:90vw}.cwn-rename-form>p{font-size:var(--dsw-font-xxs-12-font-size);color:var(--dsw-alias-label-tertiary);line-height:20px}
@media(max-width:700px){.cwn-role-grid{grid-template-columns:1fr}.cwn-roles-toolbar{flex-wrap:wrap}.cwn-roles-toolbar>span{flex-basis:100%}}
`
