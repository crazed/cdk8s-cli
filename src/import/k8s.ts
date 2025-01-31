import { CodeMaker } from 'codemaker';

// we just need the types from json-schema
// eslint-disable-next-line import/no-extraneous-dependencies
import { JSONSchema4 } from 'json-schema';

import { TypeGenerator } from 'json2jsii';
import { ImportSpec } from '../config';
import { download } from '../util';
import { GenerateOptions, ImportBase } from './base';
import { ApiObjectDefinition, emitHeader, generateConstruct, getPropsTypeName, getTypeName } from './codegen';
import { parseApiTypeName, safeParseJsonSchema } from './k8s-util';


export const DEFAULT_API_VERSION = '1.25.0';

const DEFAULT_CLASS_NAME_PREFIX = 'Kube';

export interface ImportKubernetesApiOptions {
  /**
   * The API version to generate.
   */
  readonly apiVersion: string;

  /**
   * Do not import these types. Instead, represent them as "any".
   *
   * @default - include all types that derive from the root types.
   */
  readonly exclude?: string[];
}

export class ImportKubernetesApi extends ImportBase {

  public static async match(importSpec: ImportSpec, argv: any): Promise<ImportKubernetesApiOptions | undefined> {
    const { source } = importSpec;
    if (source !== 'k8s' && !source.startsWith('k8s@')) {
      return undefined;
    }

    let k8sVersion = source.split('@')[1] ?? DEFAULT_API_VERSION;

    const k8sVersionRegex = /^\d+\.\d+\.\d+$/;
    if (!k8sVersionRegex.test(k8sVersion)) {
      throw new Error(`Expected k8s version "${k8sVersion}" to match format "<major>.<minor>.<patch>".`);
    }

    console.error(`Importing k8s v${k8sVersion}...`);

    return {
      apiVersion: k8sVersion,
      exclude: argv.exclude,
    };
  }

  constructor(private readonly options: ImportKubernetesApiOptions) {
    super();
  }

  public get moduleNames() {
    return ['k8s'];
  }

  protected async generateTypeScript(code: CodeMaker, moduleName: string, options: GenerateOptions) {
    const schema = await downloadSchema(this.options.apiVersion);

    if (moduleName !== 'k8s') {
      throw new Error(`unexpected module name "${moduleName}" when importing k8s types (expected "k8s")`);
    }

    const prefix = options.classNamePrefix ?? DEFAULT_CLASS_NAME_PREFIX;
    const topLevelObjects = findApiObjectDefinitions(schema, prefix);

    const typeGenerator = new TypeGenerator({
      definitions: schema.definitions,
      exclude: this.options.exclude,
      renderTypeName: (def: string) => {
        const parsed = parseApiTypeName(def);
        if (!parsed.version) {
          // not a versioned api type. return basename
          return parsed.basename;
        }
        return getTypeName(false, parsed.basename, parsed.version.raw);
      },
    });

    // rename "Props" type from their original name based on the API object kind
    // (e.g. `Deployment`) to their actual props type (`KubeDeploymentProps`) in
    // order to avoid confusion between constructs (`KubeDeployment`) and those
    // types. This is done by simply replacing their definition in the schema
    // with a $ref to the definition of the props type.
    for (const o of topLevelObjects) {
      typeGenerator.addDefinition(o.fqn, { $ref: `#/definitions/${getPropsTypeName(o)}` });
    }

    // emit construct types (recursive)
    for (const o of topLevelObjects) {
      generateConstruct(typeGenerator, o);
    }

    emitHeader(code, false);

    code.line(typeGenerator.render());
  }
}

/**
 * Returns a map of all API objects in the spec (objects that have the
 * 'x-kubernetes-group-version-kind' annotation).
 *
 * The key is the base name of the type (i.e. `Deployment`). Since API objects
 * may have multiple versions, each value in the map is an array of type definitions
 * along with version information.
 *
 * @see https://kubernetes.io/docs/concepts/overview/kubernetes-api/#api-versioning
 */
export function findApiObjectDefinitions(schema: JSONSchema4, prefix: string): ApiObjectDefinition[] {
  const result = new Array<ApiObjectDefinition>();

  for (const [typename, apischema] of Object.entries(schema.definitions || { })) {
    const objectName = tryGetObjectName(apischema);
    if (!objectName) {
      continue;
    }

    const type = parseApiTypeName(typename);
    if (!type.version) {
      throw new Error(`Unable to parse version for type: ${typename}`);
    }
    result.push({
      custom: false, // not a CRD
      fqn: type.fullname,
      group: objectName.group,
      kind: objectName.kind,
      version: objectName.version,
      schema: apischema,
      prefix,
    });
  }

  return result;
}

function tryGetObjectName(def: JSONSchema4): GroupVersionKind | undefined {
  const objectNames = def[X_GROUP_VERSION_KIND] as GroupVersionKind[];
  if (!objectNames) {
    return undefined;
  }

  const objectName = objectNames[0];
  if (!objectName) {
    return undefined;
  }

  // skip definitions without "metadata". they are not API objects that can be defined
  // in manifests (example: io.k8s.apimachinery.pkg.apis.meta.v1.DeleteOptions)
  // they will be treated as data types
  if (!def.properties?.metadata) {
    return undefined;
  }

  return objectName;
}

export interface GroupVersionKind {
  readonly group: string;
  readonly kind: string;
  readonly version: string;
}

const X_GROUP_VERSION_KIND = 'x-kubernetes-group-version-kind';

async function downloadSchema(apiVersion: string) {
  const url = `https://raw.githubusercontent.com/cdk8s-team/cdk8s/master/kubernetes-schemas/v${apiVersion}/_definitions.json`;
  let output;
  try {
    output = await download(url);
  } catch (e) {
    console.error(`Could not find a schema for k8s version ${apiVersion}. The current list of available schemas is at https://github.com/cdk8s-team/cdk8s/tree/master/kubernetes-schemas.`);
    throw e;
  }
  try {
    return safeParseJsonSchema(output) as JSONSchema4;
  } catch (e) {
    throw new Error(`Unable to parse schema at ${url}: ${e}`);
  }
}
