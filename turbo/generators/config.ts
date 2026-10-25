import { PlopTypes } from '@turbo/gen'

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator('app', {
    description: 'Creates a new app',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'What is the name of the new app?',
      },
    ],
    actions: [
      {
        type: 'add',
        path: '{{ turbo.paths.root }}/apps/{{ dashCase name }}/package.json',
        templateFile: 'templates/app/package.json.hbs',
      },
      {
        type: 'add',
        path: '{{ turbo.paths.root }}/apps/{{ dashCase name }}/tsconfig.json',
        templateFile: 'templates/app/tsconfig.json.hbs',
      },
      {
        type: 'add',
        path: '{{ turbo.paths.root }}/apps/{{ dashCase name }}/src/index.ts',
        templateFile: 'templates/app/src/index.ts.hbs',
      },
    ],
  })

  plop.setGenerator('device', {
    description: 'Creates a new device',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'What is the name of the new device?',
      },
    ],
    actions: [
      {
        type: 'add',
        path: '{{ turbo.paths.root }}/devices/{{ dashCase name }}/package.json',
        templateFile: 'templates/device/package.json.hbs',
      },
      {
        type: 'add',
        path: '{{ turbo.paths.root }}/devices/{{ dashCase name }}/src/index.ts',
        templateFile: 'templates/device/src/index.ts.hbs',
      },
      {
        type: 'add',
        path: '{{ turbo.paths.root }}/devices/{{ dashCase name }}/tsconfig.json',
        templateFile: 'templates/device/tsconfig.json.hbs',
      },
    ],
  })

  plop.setGenerator('module', {
    description: 'Creates a new kernel module, in TypeScript or in Rust (WebAssembly)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'What is the name of the new module?',
      },
      {
        type: 'list',
        name: 'kind',
        message: 'What is it written in?',
        choices: [
          { name: 'TypeScript (runs in the kernel, trusted)', value: 'ts' },
          { name: 'Rust (a sandboxed WebAssembly component)', value: 'rust' },
        ],
      },
    ],
    actions: data => {
      const root = '{{ turbo.paths.root }}/modules/{{ dashCase name }}'
      const files = data?.kind === 'rust'
        ? [
            ['Cargo.toml', 'Cargo.toml.hbs'],
            ['rust-toolchain.toml', 'rust-toolchain.toml'],
            ['.gitignore', 'gitignore'],
            ['module.json', 'module.json.hbs'],
            ['package.json', 'package.json.hbs'],
            ['src/lib.rs', 'src/lib.rs.hbs'],
          ]
        : [
            ['build.mjs', 'build.mjs'],
            ['module.json', 'module.json.hbs'],
            ['package.json', 'package.json.hbs'],
            ['tsconfig.json', 'tsconfig.json.hbs'],
            ['src/index.ts', 'src/index.ts.hbs'],
            ['tests/index.mjs', 'tests/index.mjs'],
          ]
      const template = data?.kind === 'rust' ? 'module-rust' : 'module-ts'
      return files.map(([file, source]) => ({
        type: 'add' as const,
        path: `${root}/${file}`,
        templateFile: `templates/${template}/${source}`,
      }))
    },
  })
}
