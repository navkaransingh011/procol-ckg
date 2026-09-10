// PER-BLOB extractor: outbound third-party services. One file per service in this repo.
export const NAME = "be-external";
export const VERSION = "1.0";

export function handles(p) {
  return p.startsWith("lib/external_api/") && p.endsWith(".rb");
}

export function extract(buf, p) {
  const src = buf.toString("utf8");
  const service = p.replace("lib/external_api/", "").replace(/\.rb$/, "");
  const hosts = [...new Set([...src.matchAll(/https?:\/\/[\w.-]+/g)].map((m) => m[0]))];
  const envs = [...new Set([...src.matchAll(/ENV\[['"]([A-Z0-9_]+)['"]\]/g)].map((m) => m[1]))];
  const verbs = [...new Set([...src.matchAll(/\b(get|post|put|patch|delete)\b\s*\(/g)]
    .map((m) => m[1].toUpperCase()))];
  return { schema: 1, service, hosts, envKeys: envs, verbs };
}

export function resolve(facts, file) {
  if (!facts?.service) return { entities: [], edges: [] };
  return {
    entities: [{
      fqn: `be:external:${facts.service}`, kind: "EXTERNAL_SERVICE", name: facts.service,
      path: file.path, blobSha: file.blobSha, startLine: null, endLine: null,
      // env KEY names only -- never a value. Nothing here can hold a secret.
      attrs: { hosts: facts.hosts, env_keys: facts.envKeys, verbs: facts.verbs },
      status: "OBSERVED", extractor: `${NAME}@${VERSION}`,
      confidence: 1.0, resolution: "EXACT",
    }],
    edges: [],
  };
}
