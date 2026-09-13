import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The container images install what their app depends on.
 *
 * Each Dockerfile copies workspace manifests one by one before installing, so
 * the install layer is cached until a dependency changes. The price is a list
 * kept by hand: a workspace package added to an app's dependencies and not to
 * its Dockerfile makes `pnpm install --filter` fail inside the image — and no
 * local run or unit test builds an image, so nothing else notices. The server
 * image went without `auth` and `player-service` that way.
 */

const ROOT = join(import.meta.dirname, '../../..');

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function workspace(): ReadonlyMap<string, { readonly dir: string; readonly manifest: Manifest }> {
  const packages = new Map<string, { dir: string; manifest: Manifest }>();
  for (const parent of ['apps', 'packages']) {
    for (const child of readdirSync(join(ROOT, parent))) {
      const dir = `${parent}/${child}`;
      const file = join(ROOT, dir, 'package.json');
      if (existsSync(file)) {
        const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
        packages.set(manifest.name, { dir, manifest });
      }
    }
  }
  return packages;
}

/** Every workspace directory `name` needs installed, itself included. */
function closure(name: string, includeDev: boolean): string[] {
  const packages = workspace();
  const seen = new Set<string>();
  const visit = (next: string): void => {
    const entry = packages.get(next);
    if (entry === undefined || seen.has(next)) {
      return;
    }
    seen.add(next);
    const { dependencies = {}, devDependencies = {} } = entry.manifest;
    for (const dependency of Object.keys({
      ...dependencies,
      ...(includeDev ? devDependencies : {}),
    })) {
      visit(dependency);
    }
  };
  visit(name);
  return [...seen].flatMap((found) => {
    const entry = packages.get(found);
    return entry === undefined ? [] : [entry.dir];
  });
}

function copiedManifests(dockerfile: string): string[] {
  const text = readFileSync(join(ROOT, 'infra/containers', dockerfile), 'utf8');
  return [...text.matchAll(/^COPY (\S+)\/package\.json /gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('container images', () => {
  it('the server image copies the manifest of every workspace package the server runs', () => {
    // Production dependencies: the image installs with `deploy --prod`.
    const missing = closure('@ponswars/server', false).filter(
      (dir) => !copiedManifests('server.Dockerfile').includes(dir),
    );

    expect(missing).toEqual([]);
  });

  it('the web image copies the manifest of every workspace package the web build uses', () => {
    // Development dependencies too: the web image runs the bundler.
    const missing = closure('@ponswars/web', true).filter(
      (dir) => !copiedManifests('web.Dockerfile').includes(dir),
    );

    expect(missing).toEqual([]);
  });
});
