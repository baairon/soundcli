// A handle only locates an account: people rename them, and the platform's own
// id for the account never changes. The first time an account is listed, its id
// is filed here under the owner key its handle gave it. From then on the id
// answers with that same owner whatever the handle has become, so a rename
// keeps its folders and nothing downloads twice.

import { promises as fs } from "node:fs";
import path from "node:path";
import { accountsFile } from "../config/paths";
import type { SourceId } from "../library/types";
import type { YtCollection } from "../ytdlp/ytdlp";

type PerSource = Partial<Record<SourceId, Record<string, string>>>;

interface Registry {
  /** Owner key per account id. */
  accounts: PerSource;
  /** The owner each handle led to the last time it was listed. */
  handles: PerSource;
}

async function load(file: string): Promise<Registry> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
      version?: number;
      accounts?: PerSource;
      handles?: PerSource;
    };
    if (parsed?.version === 1 && parsed.accounts) {
      return { accounts: parsed.accounts, handles: parsed.handles ?? {} };
    }
  } catch {
    // missing or invalid: nobody is known yet
  }
  return { accounts: {}, handles: {} };
}

async function save(file: string, registry: Registry): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, ...registry }, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/**
 * The platform's id for the account a listing belongs to. Only a profile's own
 * listing names one: a set's id is the set, and a playlist's channel is whoever
 * made it, so callers pass nothing but the profile's feeds.
 */
export function accountIdOf(
  source: SourceId,
  col: YtCollection,
): string | undefined {
  if (source === "soundcloud") {
    const id = String(col.id ?? "");
    return col.extractorKey === "SoundcloudUser" && /^\d+$/.test(id)
      ? id
      : undefined;
  }
  if (source === "youtube") {
    const id = String(col.channelId ?? "");
    return /^UC[\w-]{22}$/.test(id) ? id : undefined;
  }
  return undefined;
}

// Lookups file what they learn, so they take turns at the registry.
let turn: Promise<unknown> = Promise.resolve();

/**
 * The owner key for an account: the one it was first seen under when its id is
 * known, else the one its handle gives it, now filed against the id. A handle
 * an earlier account already holds leads to a different account, which gets a
 * key of its own rather than the earlier one's folders. Never throws: with no
 * id, or a registry that can't be read or written, the handle decides as it
 * always has.
 */
export function ownerForAccount(
  source: SourceId,
  accountId: string | undefined,
  handleOwner: string,
  file: string = accountsFile,
): Promise<string> {
  if (!accountId) return Promise.resolve(handleOwner);
  // The suite's fixtures must never be filed in the user's own registry.
  if (process.env.VITEST && file === accountsFile) {
    return Promise.resolve(handleOwner);
  }
  const answer = turn
    .then(async () => {
      const registry = await load(file);
      const known = (registry.accounts[source] ??= {});
      const located = (registry.handles[source] ??= {});
      const filed = known[accountId];
      if (filed) {
        // Note where this handle leads now, for ownerForHandle. A registry
        // that can't be written still knows who the account is.
        if (located[handleOwner] !== filed) {
          located[handleOwner] = filed;
          await save(file, registry).catch(() => {});
        }
        return filed;
      }
      const owner = Object.values(known).includes(handleOwner)
        ? `${handleOwner}-${accountId}`
        : handleOwner;
      known[accountId] = owner;
      located[handleOwner] = owner;
      await save(file, registry);
      return owner;
    })
    .catch(() => handleOwner);
  turn = answer;
  return answer;
}

/**
 * The owner a handle led to the last time it was listed, for a caller that
 * holds a handle and no listing. After a rename the handle in the config is
 * the new one while the folders still carry the first one's name. A handle
 * never listed yet is its own owner.
 */
export async function ownerForHandle(
  source: SourceId,
  handleOwner: string,
  file: string = accountsFile,
): Promise<string> {
  if (process.env.VITEST && file === accountsFile) return handleOwner;
  // Behind any lookup still filing what it learned.
  await turn.catch(() => {});
  const { handles } = await load(file);
  return handles[source]?.[handleOwner] ?? handleOwner;
}
