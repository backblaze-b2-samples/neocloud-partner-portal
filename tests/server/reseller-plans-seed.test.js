// The plan catalog is operator-managed, so an empty table means "no tiers
// defined", not "needs seeding". Seeding used to fire whenever the table was
// empty, which handed the sample tiers back to anyone who deleted them to make
// room for their own — on every server restart.
//
// seedOnce is called directly rather than by re-importing the module: the test
// database is :memory:, so a fresh import would open a different one.
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../server/db.js';
import { seedOnce } from '../../server/routes/resellerPlans.js';

const planCount = () => db.prepare('SELECT COUNT(*) AS n FROM reseller_plans').get().n;
const marker    = () => db.prepare("SELECT value FROM app_meta WHERE key = 'reseller_plans_seeded'").get();

beforeEach(() => {
  db.prepare('DELETE FROM reseller_plans').run();
  db.prepare("DELETE FROM app_meta WHERE key = 'reseller_plans_seeded'").run();
});

describe('seeding the default tiers', () => {
  it('seeds a database that has never been seeded', () => {
    seedOnce();
    expect(planCount()).toBe(3);
    expect(marker()).toBeTruthy();
  });

  it('does not re-seed after the operator deletes the samples', () => {
    seedOnce();
    expect(planCount()).toBe(3);

    db.prepare('DELETE FROM reseller_plans').run();
    seedOnce();

    // The regression: sample tiers reappearing in a customer's portal.
    expect(planCount()).toBe(0);
  });

  it('leaves an operator-built catalog alone across restarts', () => {
    seedOnce();
    db.prepare('DELETE FROM reseller_plans').run();
    db.prepare(`
      INSERT INTO reseller_plans (id, name, storage_per_tb, egress_per_gb,
        class_a_per_10k, class_b_per_10k, class_c_per_10k, class_d_per_10k, position, updated_at)
      VALUES ('p-hot', 'Aylo Hot', 3.42, 0.01, 0, 0, 0, 0, 1, datetime('now'))
    `).run();

    seedOnce();

    const names = db.prepare('SELECT name FROM reseller_plans').all().map((r) => r.name);
    expect(names).toEqual(['Aylo Hot']);
  });

  it('back-fills the marker for a database seeded before it existed', () => {
    // Pre-marker deployment: rows present, no marker.
    db.prepare(`
      INSERT INTO reseller_plans (id, name, storage_per_tb, egress_per_gb,
        class_a_per_10k, class_b_per_10k, class_c_per_10k, class_d_per_10k, position, updated_at)
      VALUES ('p-existing', 'Existing', 10, 0.01, 0, 0, 0, 0, 1, datetime('now'))
    `).run();
    expect(marker()).toBeFalsy();

    seedOnce();

    expect(marker()).toBeTruthy();
    expect(planCount()).toBe(1); // upgrade must not append the samples
  });
});
