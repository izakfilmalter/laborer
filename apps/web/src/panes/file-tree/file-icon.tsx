import { cn } from '@laborer/ui/lib/utils'
import type { SVGProps } from 'react'
import { useId, useMemo } from 'react'
import sprite from '@/assets/file-icons/sprite.svg'

interface FileIconProps extends SVGProps<SVGSVGElement> {
  readonly expanded?: boolean
  readonly mono?: boolean
  readonly node: {
    readonly path: string
    readonly type: 'file' | 'directory'
  }
}

interface IconMaps {
  readonly defaults: {
    readonly file: string
    readonly folder: string
    readonly folderOpen: string
  }
  readonly fileExtensions: Record<string, string>
  readonly fileNames: Record<string, string>
  readonly folderNames: Record<string, string>
}

// Ported from OpenCode's @opencode-ai/ui/file-icon so the tree matches the
// reference app's extension-aware file icons.
const ICON_MAPS: IconMaps = {
  fileNames: {
    'readme.md': 'Readme',
    'changelog.md': 'Changelog',
    'contributing.md': 'Contributing',
    'conduct.md': 'Conduct',
    license: 'Certificate',
    authors: 'Authors',
    credits: 'Credits',
    install: 'Installation',
    'package.json': 'Nodejs',
    'package-lock.json': 'Nodejs',
    'yarn.lock': 'Yarn',
    'pnpm-lock.yaml': 'Pnpm',
    'bun.lock': 'Bun',
    'bun.lockb': 'Bun',
    'bunfig.toml': 'Bun',
    '.nvmrc': 'Nodejs',
    '.node-version': 'Nodejs',
    dockerfile: 'Docker',
    'docker-compose.yml': 'Docker',
    'docker-compose.yaml': 'Docker',
    '.dockerignore': 'Docker',
    'jest.config.js': 'Jest',
    'jest.config.ts': 'Jest',
    'jest.config.mjs': 'Jest',
    'vitest.config.js': 'Vitest',
    'vitest.config.ts': 'Vitest',
    'tailwind.config.js': 'Tailwindcss',
    'tailwind.config.ts': 'Tailwindcss',
    'turbo.json': 'Turborepo',
    'tsconfig.json': 'Tsconfig',
    'jsconfig.json': 'Jsconfig',
    '.eslintrc': 'Eslint',
    '.eslintrc.js': 'Eslint',
    '.eslintrc.json': 'Eslint',
    '.prettierrc': 'Prettier',
    '.prettierrc.js': 'Prettier',
    '.prettierrc.json': 'Prettier',
    'vite.config.js': 'Vite',
    'vite.config.ts': 'Vite',
    'webpack.config.js': 'Webpack',
    'rollup.config.js': 'Rollup',
    'astro.config.mjs': 'AstroConfig',
    'astro.config.js': 'AstroConfig',
    'next.config.js': 'Next',
    'next.config.mjs': 'Next',
    'nuxt.config.js': 'Nuxt',
    'nuxt.config.ts': 'Nuxt',
    'svelte.config.js': 'Svelte',
    'gatsby-config.js': 'Gatsby',
    'remix.config.js': 'Remix',
    'prisma.schema': 'Prisma',
    '.gitignore': 'Git',
    '.gitattributes': 'Git',
    makefile: 'Makefile',
    cmake: 'Cmake',
    'cargo.toml': 'Rust',
    'go.mod': 'GoMod',
    'go.sum': 'GoMod',
    'requirements.txt': 'Python',
    'pyproject.toml': 'Python',
    pipfile: 'Python',
    'poetry.lock': 'Poetry',
    gemfile: 'Gemfile',
    rakefile: 'Ruby',
    'composer.json': 'Php',
    'build.gradle': 'Gradle',
    'pom.xml': 'Maven',
    'deno.json': 'Deno',
    'deno.jsonc': 'Deno',
    'vercel.json': 'Vercel',
    'netlify.toml': 'Netlify',
    '.env': 'Tune',
    '.env.local': 'Tune',
    '.env.development': 'Tune',
    '.env.production': 'Tune',
    '.env.example': 'Tune',
    '.editorconfig': 'Editorconfig',
    'robots.txt': 'Robots',
    'favicon.ico': 'Favicon',
    browserlist: 'Browserlist',
    '.babelrc': 'Babel',
    'babel.config.js': 'Babel',
    'gulpfile.js': 'Gulp',
    'gruntfile.js': 'Grunt',
    'capacitor.config.json': 'Capacitor',
    'ionic.config.json': 'Ionic',
    'angular.json': 'Angular',
    '.storybook': 'Storybook',
    'storybook.config.js': 'Storybook',
    'cypress.config.js': 'Cypress',
    'playwright.config.js': 'Playwright',
    'puppeteer.config.js': 'Puppeteer',
    'wrangler.toml': 'Wrangler',
    'firebase.json': 'Firebase',
    supabase: 'Supabase',
    terraform: 'Terraform',
    kubernetes: 'Kubernetes',
    '.gitpod.yml': 'Gitpod',
    '.devcontainer': 'Vscode',
    'travis.yml': 'Travis',
    'appveyor.yml': 'Appveyor',
    '.circleci': 'Circleci',
    'renovate.json': 'Renovate',
    'dependabot.yml': 'Dependabot',
    'lerna.json': 'Lerna',
    'nx.json': 'Nx',
  },
  fileExtensions: {
    'spec.ts': 'TestTs',
    'test.ts': 'TestTs',
    'spec.tsx': 'TestJsx',
    'test.tsx': 'TestJsx',
    'spec.js': 'TestJs',
    'test.js': 'TestJs',
    'spec.jsx': 'TestJsx',
    'test.jsx': 'TestJsx',
    'js.map': 'JavascriptMap',
    'd.ts': 'TypescriptDef',
    ts: 'Typescript',
    tsx: 'React_ts',
    js: 'Javascript',
    jsx: 'React',
    mjs: 'Javascript',
    cjs: 'Javascript',
    html: 'Html',
    htm: 'Html',
    css: 'Css',
    scss: 'Sass',
    sass: 'Sass',
    less: 'Less',
    styl: 'Stylus',
    json: 'Json',
    xml: 'Xml',
    yml: 'Yaml',
    yaml: 'Yaml',
    toml: 'Toml',
    hjson: 'Hjson',
    md: 'Markdown',
    mdx: 'Mdx',
    tex: 'Tex',
    py: 'Python',
    pyx: 'Python',
    pyw: 'Python',
    rs: 'Rust',
    go: 'Go',
    java: 'Java',
    kt: 'Kotlin',
    scala: 'Scala',
    php: 'Php',
    rb: 'Ruby',
    cs: 'Csharp',
    vb: 'Visualstudio',
    cpp: 'Cpp',
    cc: 'Cpp',
    cxx: 'Cpp',
    c: 'C',
    h: 'H',
    hpp: 'Hpp',
    swift: 'Swift',
    m: 'ObjectiveC',
    mm: 'ObjectiveCpp',
    dart: 'Dart',
    lua: 'Lua',
    pl: 'Perl',
    r: 'R',
    jl: 'Julia',
    hs: 'Haskell',
    elm: 'Elm',
    ml: 'Ocaml',
    clj: 'Clojure',
    cljs: 'Clojure',
    erl: 'Erlang',
    ex: 'Elixir',
    exs: 'Elixir',
    nim: 'Nim',
    zig: 'Zig',
    v: 'Vlang',
    odin: 'Odin',
    gleam: 'Gleam',
    grain: 'Grain',
    roc: 'Rocket',
    fs: 'Fsharp',
    sh: 'Console',
    bash: 'Console',
    zsh: 'Console',
    fish: 'Console',
    ps1: 'Powershell',
    cfg: 'Settings',
    ini: 'Settings',
    conf: 'Settings',
    properties: 'Settings',
    svg: 'Svg',
    png: 'Image',
    jpg: 'Image',
    jpeg: 'Image',
    gif: 'Image',
    webp: 'Image',
    bmp: 'Image',
    ico: 'Favicon',
    mp4: 'Video',
    mov: 'Video',
    avi: 'Video',
    webm: 'Video',
    mp3: 'Audio',
    wav: 'Audio',
    flac: 'Audio',
    zip: 'Zip',
    tar: 'Zip',
    gz: 'Zip',
    rar: 'Zip',
    '7z': 'Zip',
    pdf: 'Pdf',
    doc: 'Word',
    docx: 'Word',
    ppt: 'Powerpoint',
    pptx: 'Powerpoint',
    xls: 'Document',
    xlsx: 'Document',
    sql: 'Database',
    db: 'Database',
    sqlite: 'Database',
    env: 'Tune',
    log: 'Log',
    lock: 'Lock',
    key: 'Key',
    pem: 'Certificate',
    crt: 'Certificate',
    proto: 'Proto',
    graphql: 'Graphql',
    gql: 'Graphql',
    wasm: 'Webassembly',
    dockerfile: 'Docker',
  },
  folderNames: {
    src: 'FolderSrc',
    source: 'FolderSrc',
    lib: 'FolderLib',
    libs: 'FolderLib',
    test: 'FolderTest',
    tests: 'FolderTest',
    testing: 'FolderTest',
    spec: 'FolderTest',
    specs: 'FolderTest',
    __tests__: 'FolderTest',
    e2e: 'FolderTest',
    integration: 'FolderTest',
    unit: 'FolderTest',
    cypress: 'FolderCypress',
    node_modules: 'FolderNode',
    vendor: 'FolderPackages',
    packages: 'FolderPackages',
    deps: 'FolderPackages',
    build: 'FolderBuildkite',
    dist: 'FolderDist',
    out: 'FolderDist',
    output: 'FolderDist',
    target: 'FolderTarget',
    config: 'FolderConfig',
    configs: 'FolderConfig',
    configuration: 'FolderConfig',
    settings: 'FolderConfig',
    env: 'FolderEnvironment',
    environments: 'FolderEnvironment',
    docker: 'FolderDocker',
    dockerfiles: 'FolderDocker',
    containers: 'FolderDocker',
    docs: 'FolderDocs',
    doc: 'FolderDocs',
    documentation: 'FolderDocs',
    readme: 'FolderDocs',
    public: 'FolderPublic',
    static: 'FolderPublic',
    assets: 'FolderImages',
    images: 'FolderImages',
    img: 'FolderImages',
    icons: 'FolderImages',
    media: 'FolderImages',
    fonts: 'FolderFont',
    styles: 'FolderCss',
    stylesheets: 'FolderCss',
    css: 'FolderCss',
    sass: 'FolderSass',
    scss: 'FolderSass',
    less: 'FolderLess',
    scripts: 'FolderScripts',
    script: 'FolderScripts',
    tools: 'FolderTools',
    utils: 'FolderUtils',
    utilities: 'FolderUtils',
    helpers: 'FolderHelper',
    components: 'FolderComponents',
    component: 'FolderComponents',
    views: 'FolderViews',
    view: 'FolderViews',
    layouts: 'FolderLayout',
    layout: 'FolderLayout',
    templates: 'FolderTemplate',
    template: 'FolderTemplate',
    hooks: 'FolderHook',
    hook: 'FolderHook',
    store: 'FolderStore',
    stores: 'FolderStore',
    state: 'FolderNgrxStore',
    reducers: 'FolderReduxReducer',
    reducer: 'FolderReduxReducer',
    services: 'FolderApi',
    service: 'FolderApi',
    api: 'FolderApi',
    apis: 'FolderApi',
    routes: 'FolderRoutes',
    route: 'FolderRoutes',
    routing: 'FolderRoutes',
    middleware: 'FolderMiddleware',
    middlewares: 'FolderMiddleware',
    controllers: 'FolderController',
    controller: 'FolderController',
    models: 'FolderDatabase',
    model: 'FolderDatabase',
    schemas: 'FolderDatabase',
    schema: 'FolderDatabase',
    migrations: 'FolderDatabase',
    migration: 'FolderDatabase',
    seeders: 'FolderSeeders',
    seeder: 'FolderSeeders',
    types: 'FolderTypescript',
    typing: 'FolderTypescript',
    typings: 'FolderTypescript',
    '@types': 'FolderTypescript',
    interfaces: 'FolderInterface',
    interface: 'FolderInterface',
    android: 'FolderAndroid',
    ios: 'FolderIos',
    mobile: 'FolderMobile',
    flutter: 'FolderFlutter',
    kubernetes: 'FolderKubernetes',
    k8s: 'FolderKubernetes',
    terraform: 'FolderTerraform',
    aws: 'FolderAws',
    azure: 'FolderAzurePipelines',
    firebase: 'FolderFirebase',
    supabase: 'FolderSupabase',
    vercel: 'FolderVercel',
    netlify: 'FolderNetlify',
    '.github': 'FolderGithub',
    '.gitlab': 'FolderGitlab',
    '.circleci': 'FolderCircleci',
    ci: 'FolderCi',
    '.ci': 'FolderCi',
    workflows: 'FolderGhWorkflows',
    '.git': 'FolderGit',
    '.vscode': 'FolderVscode',
    '.idea': 'FolderIntellij',
    '.cursor': 'FolderCursor',
    '.devcontainer': 'FolderContainer',
    '.storybook': 'FolderStorybook',
    i18n: 'FolderI18n',
    locales: 'FolderI18n',
    locale: 'FolderI18n',
    lang: 'FolderI18n',
    languages: 'FolderI18n',
    temp: 'FolderTemp',
    tmp: 'FolderTemp',
    logs: 'FolderLog',
    log: 'FolderLog',
    backup: 'FolderBackup',
    backups: 'FolderBackup',
    examples: 'FolderExamples',
    example: 'FolderExamples',
    demo: 'FolderExamples',
    demos: 'FolderExamples',
    samples: 'FolderExamples',
    sample: 'FolderExamples',
    fixtures: 'FolderTest',
    mocks: 'FolderMock',
    mock: 'FolderMock',
    data: 'FolderDatabase',
    database: 'FolderDatabase',
    db: 'FolderDatabase',
    sql: 'FolderDatabase',
    prisma: 'FolderPrisma',
    drizzle: 'FolderDrizzle',
    security: 'FolderSecure',
    auth: 'FolderSecure',
    authentication: 'FolderSecure',
    authorization: 'FolderSecure',
    keys: 'FolderKeys',
    certs: 'FolderKeys',
    certificates: 'FolderKeys',
    content: 'FolderContent',
    posts: 'FolderContent',
    articles: 'FolderContent',
    blog: 'FolderContent',
    functions: 'FolderFunctions',
    function: 'FolderFunctions',
    lambda: 'FolderFunctions',
    lambdas: 'FolderFunctions',
    serverless: 'FolderServerless',
    jobs: 'FolderJob',
    job: 'FolderJob',
    tasks: 'FolderTasks',
    task: 'FolderTasks',
    cron: 'FolderTasks',
    queue: 'FolderQueue',
    queues: 'FolderQueue',
    desktop: 'FolderDesktop',
    windows: 'FolderWindows',
    macos: 'FolderMacos',
    linux: 'FolderLinux',
  },
  defaults: {
    file: 'Document',
    folder: 'Folder',
    folderOpen: 'FolderOpen',
  },
}

const toOpenVariant = (icon: string): string => {
  if (!icon.startsWith('Folder')) {
    return icon
  }
  if (icon.endsWith('_light')) {
    return icon.replace('_light', 'Open_light')
  }
  if (!icon.endsWith('Open')) {
    return `${icon}Open`
  }
  return icon
}

const basenameOf = (path: string) =>
  path.split('\\').join('/').split('/').filter(Boolean).pop() ?? ''

const folderNameVariants = (name: string) => {
  const normalized = name.toLowerCase()
  return [normalized, `.${normalized}`, `_${normalized}`, `__${normalized}__`]
}

const dottedSuffixesDesc = (name: string) => {
  const normalized = name.toLowerCase()
  const indexes: number[] = []

  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '.') {
      indexes.push(i)
    }
  }

  const suffixes = new Set<string>()
  suffixes.add(normalized)

  for (const index of indexes) {
    if (index + 1 < normalized.length) {
      suffixes.add(normalized.slice(index + 1))
    }
  }

  return Array.from(suffixes).sort((a, b) => b.length - a.length)
}

export function chooseIconName(
  path: string,
  type: 'directory' | 'file',
  expanded: boolean
): string {
  const base = basenameOf(path)
  const baseLower = base.toLowerCase()

  if (type === 'directory') {
    for (const candidate of folderNameVariants(baseLower)) {
      const icon = ICON_MAPS.folderNames[candidate]
      if (icon !== undefined) {
        return expanded ? toOpenVariant(icon) : icon
      }
    }

    return expanded ? ICON_MAPS.defaults.folderOpen : ICON_MAPS.defaults.folder
  }

  const byName = ICON_MAPS.fileNames[baseLower]
  if (byName !== undefined) {
    return byName
  }

  for (const extension of dottedSuffixesDesc(baseLower)) {
    const icon = ICON_MAPS.fileExtensions[extension]
    if (icon !== undefined) {
      return icon
    }
  }

  return ICON_MAPS.defaults.file
}

export function FileIcon({
  className,
  expanded = false,
  mono = false,
  node,
  ...props
}: FileIconProps) {
  const iconName = useMemo(
    () => chooseIconName(node.path, node.type, expanded),
    [expanded, node.path, node.type]
  )
  const maskId = useId().replace(/:/g, '')

  return (
    <svg
      aria-hidden="true"
      className={cn('block size-4 shrink-0', className)}
      data-component="file-icon"
      focusable="false"
      {...props}
    >
      {mono ? (
        <>
          <defs>
            <mask id={maskId}>
              <use href={`${sprite}#${iconName}`} />
            </mask>
          </defs>
          <rect
            fill="currentColor"
            height="100%"
            mask={`url(#${maskId})`}
            width="100%"
          />
        </>
      ) : (
        <use href={`${sprite}#${iconName}`} />
      )}
    </svg>
  )
}
