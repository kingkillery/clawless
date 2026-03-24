import type { ToolPresetDefinition, ToolPresetInput } from './types.js';

/** Built-in launch presets for common pure-JS tools that work in WebContainers. */
const BUILTIN_TOOL_PRESETS: ToolPresetDefinition[] = [
  {
    name: 'pptx',
    description: 'Presentation generation with pptxgenjs.',
    services: {
      pptxgenjs: '^3.12.0',
    },
    workspace: {
      'tools/pptx.md': [
        '# PPTX Tool',
        '',
        '- Use `pptxgenjs` to generate `.pptx` files from code.',
        '- Prefer writing a script in `workspace/` that saves output into the project tree.',
      ].join('\n') + '\n',
    },
  },
  {
    name: 'spreadsheet',
    description: 'Spreadsheet parsing and export with xlsx.',
    services: {
      xlsx: '^0.18.5',
    },
    workspace: {
      'tools/spreadsheet.md': [
        '# Spreadsheet Tool',
        '',
        '- Use `xlsx` to read and write `.xlsx`, `.csv`, and tabular exports.',
        '- Keep generated artifacts inside `workspace/` so they remain visible in the file tree.',
      ].join('\n') + '\n',
    },
  },
  {
    name: 'pdf',
    description: 'PDF editing and generation with pdf-lib.',
    services: {
      'pdf-lib': '^1.17.1',
    },
    workspace: {
      'tools/pdf.md': [
        '# PDF Tool',
        '',
        '- Use `pdf-lib` for pure-JS PDF generation, merge, split, and metadata edits.',
        '- Prefer script-based generation over native binaries because ClawLess runs in WebContainers.',
      ].join('\n') + '\n',
    },
  },
  {
    name: 'charts',
    description: 'Chart rendering with chart.js.',
    services: {
      'chart.js': '^4.4.3',
    },
    workspace: {
      'tools/charts.md': [
        '# Charts Tool',
        '',
        '- Use `chart.js` for chart configuration and browser-rendered visualizations.',
        '- Save chart configs or HTML previews into `workspace/` for inspection.',
      ].join('\n') + '\n',
    },
  },
];

export class ToolPresetRegistry {
  private presets = new Map<string, ToolPresetDefinition>();

  constructor() {
    for (const preset of BUILTIN_TOOL_PRESETS) this.register(preset);
  }

  register(preset: ToolPresetDefinition): void {
    this.presets.set(preset.name, preset);
  }

  get(name: string): ToolPresetDefinition | undefined {
    return this.presets.get(name);
  }

  list(): string[] {
    return [...this.presets.keys()];
  }

  get all(): Map<string, ToolPresetDefinition> {
    return this.presets;
  }
}

export function resolveToolPresets(
  inputs: ToolPresetInput[] | undefined,
  registry: ToolPresetRegistry,
): ToolPresetDefinition[] {
  if (!inputs || inputs.length === 0) return [];
  return inputs.map((input) => {
    if (typeof input !== 'string') return input;
    const preset = registry.get(input);
    if (!preset) {
      throw new Error(`Unknown tool preset: "${input}". Registered: ${registry.list().join(', ')}`);
    }
    return preset;
  });
}

export function buildToolPresetWorkspace(presets: ToolPresetDefinition[]): Record<string, string> {
  if (presets.length === 0) return {};
  return {
    'TOOLS.md': renderToolsMarkdown(presets),
  };
}

export function mergeToolPresetContributions(presets: ToolPresetDefinition[]): {
  services: Record<string, string>;
  workspace: Record<string, string>;
  env: Record<string, string>;
  startupScript?: string;
} {
  const services: Record<string, string> = {};
  const workspace: Record<string, string> = {};
  const env: Record<string, string> = {};
  const startupScripts: string[] = [];

  for (const preset of presets) {
    Object.assign(services, preset.services);
    Object.assign(workspace, preset.workspace);
    Object.assign(env, preset.env);
    if (preset.startupScript) startupScripts.push(preset.startupScript);
  }

  return {
    services,
    workspace,
    env,
    startupScript: startupScripts.length > 0 ? startupScripts.join('\n') : undefined,
  };
}

function renderToolsMarkdown(presets: ToolPresetDefinition[]): string {
  const lines = ['# Tools', '', 'The following launch presets are installed in this workspace:', ''];
  for (const preset of presets) {
    lines.push(`- \`${preset.name}\`${preset.description ? ` — ${preset.description}` : ''}`);
  }
  lines.push('', 'Inspect the matching files under `tools/` for usage hints.');
  lines.push('');
  return lines.join('\n');
}
