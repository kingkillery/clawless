import { ClawContainer } from './sdk.js';

// ─── Template Selection → Boot ──────────────────────────────────────────────

function waitForTemplateSelection(): Promise<string> {
  return new Promise((resolve) => {
    // Pre-select the last used template (but still require a click)
    const saved = localStorage.getItem('clawchef_template');
    const buttons = document.querySelectorAll<HTMLButtonElement>('.tpl-btn');
    if (saved) {
      buttons.forEach((btn) => {
        if (btn.dataset['template'] === saved) btn.classList.add('tpl-btn-last');
      });
    }

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const template = btn.dataset['template'] ?? 'gitclaw';
        const runtime = btn.dataset['runtime'];
        localStorage.setItem('clawchef_template', template);
        if (runtime) {
          localStorage.setItem('clawchef_runtime', runtime);
        }
        resolve(template);
      });
    });
  });
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const template = params.get('template') ?? await waitForTemplateSelection();
  const templateRuntime = ClawContainer.templates.get(template)?.runtime;
  const toolPresets = params.get('tools')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const runtime = params.get('runtime')
    ?? templateRuntime
    ?? localStorage.getItem('clawchef_runtime')
    ?? undefined;
  const runnerUrl = params.get('runner')
    ?? localStorage.getItem('clawchef_runnerUrl')
    ?? 'http://127.0.0.1:6234';

  if (runtime) {
    localStorage.setItem('clawchef_runtime', runtime);
  }
  localStorage.setItem('clawchef_runnerUrl', runnerUrl);

  // Hide picker, show loading status
  const picker = document.getElementById('template-picker');
  const status = document.getElementById('loading-status');
  const progressBar = status?.nextElementSibling as HTMLElement | null;
  if (picker) picker.style.display = 'none';
  if (status) status.style.display = '';
  if (progressBar) progressBar.style.display = '';

  const cc = new ClawContainer('#app', {
    template,
    toolPresets,
    runtime: runtime as 'webcontainer' | 'external-local' | undefined,
    runnerUrl,
  });
  cc.start().catch(console.error);

  // Expose SDK globally for console access and external scripts
  (window as any).clawcontainer = cc;
}

boot();
