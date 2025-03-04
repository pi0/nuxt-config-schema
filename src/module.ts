import { existsSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'pathe'
import { defu } from 'defu'
import { defineNuxtModule, createResolver } from '@nuxt/kit'
import {
  resolveSchema as resolveUntypedSchema,
  generateMarkdown,
  generateTypes,
} from 'untyped'
import type { Schema, SchemaDefinition } from 'untyped'
// @ts-ignore
import untypedPlugin from 'untyped/babel-plugin'
import { createJiti } from 'jiti'

export type NuxtConfigSchema = SchemaDefinition

declare module '@nuxt/schema' {
  interface NuxtConfig {
    ['$schema']?: NuxtConfigSchema
  }
  interface NuxtOptions {
    ['$schema']: NuxtConfigSchema
  }
  interface NuxtHooks {
    'schema:extend': (schemas: SchemaDefinition[]) => void
    'schema:resolved': (schema: Schema) => void
    'schema:beforeWrite': (schema: Schema) => void
    'schema:written': () => void
  }
}

declare global {
  /** @deprecated Use Nuxt 3.1 with defineNuxtSchema */
  const defineNuxtConfigSchema: (schema: NuxtConfigSchema) => NuxtConfigSchema
}

export default defineNuxtModule({
  meta: {
    name: 'nuxt-config-schema-compat',
  },
  async setup(options, nuxt) {
    // Enable experimental flag when supported version of Nuxt detected
    // https://github.com/nuxt/nuxt/pull/18410
    // @ts-ignore
    if (nuxt.options.experimental.configSchema !== undefined /* >= 3.1.0 */) {
      // @ts-ignore
      nuxt.options.experimental.configSchema = true
      // @ts-ignore
      globalThis.defineNuxtConfigSchema = (val: any) => val
      return
    }

    const resolver = createResolver(import.meta.url)

    // Initialize untyped/jiti loader
    const virtualImports = await resolver.resolvePath(
      './runtime/virtual-imports'
    )
    const jiti = createJiti(dirname(import.meta.url), {
      cache: false,
      requireCache: false,
      alias: {
        '#imports': virtualImports,
        'nuxt/config': virtualImports,
      },
      transformOptions: {
        babel: {
          plugins: [untypedPlugin],
        },
      },
    })

    // Register module types
    nuxt.hook('prepare:types', (ctx) => {
      ctx.references.push({ path: 'nuxt-config-schema' })
      ctx.references.push({ path: 'schema/nuxt.schema.d.ts' })
    })

    // Resolve schema after all modules initialized
    let schema: Schema
    nuxt.hook('modules:done', async () => {
      schema = await resolveSchema()
    })

    // Writie schema after build to allow further modifications
    nuxt.hooks.hook('build:done', async () => {
      await nuxt.hooks.callHook('schema:beforeWrite', schema)
      await writeSchema(schema)
      await nuxt.hooks.callHook('schema:written')
    })

    // --- Bound utils ---

    async function resolveSchema() {
      // Global import
      // @ts-ignore
      globalThis.defineNuxtConfigSchema = (val: any) => val

      // Load schema from layers
      const schemaDefs: SchemaDefinition[] = [nuxt.options.$schema]
      for (const layer of nuxt.options._layers) {
        const filePath = await resolver.resolvePath(
          resolve(layer.config.rootDir, 'nuxt.schema')
        )
        if (filePath && existsSync(filePath)) {
          let loadedConfig: SchemaDefinition
          try {
            loadedConfig = await jiti.import(filePath, { default: true })
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              '[nuxt-config-schema] Unable to load schema from',
              filePath,
              err
            )
            continue
          }
          schemaDefs.push(loadedConfig)
        }
      }

      // Allow hooking to extend custom schemas
      await nuxt.hooks.callHook('schema:extend', schemaDefs)

      // Resolve and merge schemas
      const schemas = await Promise.all(
        schemaDefs.map((schemaDef) => resolveUntypedSchema(schemaDef))
      )
      // @ts-expect-error
      // Merge after normalazation
      const schema = defu(...schemas)

      // Allow hooking to extend resolved schema
      await nuxt.hooks.callHook('schema:resolved', schema)

      return schema
    }

    async function writeSchema(schema: Schema) {
      // Write it to build dir
      await mkdir(resolve(nuxt.options.buildDir, 'schema'), { recursive: true })
      await writeFile(
        resolve(nuxt.options.buildDir, 'schema/nuxt.schema.json'),
        JSON.stringify(schema, null, 2),
        'utf8'
      )
      const markdown = '# User config schema' + generateMarkdown(schema)
      await writeFile(
        resolve(nuxt.options.buildDir, 'schema/nuxt.schema.md'),
        markdown,
        'utf8'
      )
      const _types = generateTypes(schema, {
        addExport: true,
        interfaceName: 'NuxtUserConfig',
        partial: true,
      })
      const types =
        _types +
        `
export type UserAppConfig = Exclude<NuxtUserConfig['appConfig'], undefined>

declare module '@nuxt/schema' {
  interface NuxtConfig extends NuxtUserConfig {}
  interface NuxtOptions extends NuxtUserConfig {}
  interface AppConfigInput extends UserAppConfig {}
  interface AppConfig extends UserAppConfig {}
}`
      const typesPath = resolve(
        nuxt.options.buildDir,
        'schema/nuxt.schema.d.ts'
      )
      await writeFile(typesPath, types, 'utf8')
    }
  },
}) as any
