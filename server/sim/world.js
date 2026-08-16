// Le monde statique, construit UNE fois pour tout le serveur et partage par toutes les
// parties (rien n'y est mutable).

import { buildMap, terrainHeight, surfaceTypeAt, zoneNameAt } from '../../shared/mapdata.js';
import { CollisionWorld } from '../../shared/collision.js';
import { WORLD_HALF } from '../../shared/constants.js';

let _shared = null;

export function getWorld() {
  if (_shared) return _shared;
  const t0 = Date.now();
  const map = buildMap();
  const collision = new CollisionWorld(map.colliders, terrainHeight, { half: WORLD_HALF });
  _shared = {
    map,
    collision,
    terrain: terrainHeight,
    surfaceAt: surfaceTypeAt,
    zoneNameAt,
    ctx: { world: collision, terrain: terrainHeight },
    buildMs: Date.now() - t0,
  };
  return _shared;
}

/** Resume envoye aux clients au demarrage d'une partie (ils regenerent le reste eux memes). */
export function mapSummary() {
  const { map } = getWorld();
  return {
    name: map.name,
    seed: map.seed,
    size: map.size,
    pois: map.pois.map((p) => ({ id: p.id, name: p.name, x: p.x, z: p.z, r: p.r, kind: p.kind })),
  };
}
