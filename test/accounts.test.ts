import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const enumerateMock = vi.fn();
vi.mock("../src/ytdlp/ytdlp", () => ({
  enumerate: (...a: unknown[]) => enumerateMock(...a),
}));

import {
  accountIdOf,
  ownerForAccount,
  ownerForHandle,
} from "../src/sources/accounts";
import { makeSoundcloud } from "../src/sources/soundcloud";
import { makeYoutube } from "../src/sources/youtube";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundcli-acct-"));
  file = path.join(dir, "accounts.json");
  enumerateMock.mockReset();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ownerForAccount", () => {
  it("files an account under its first handle and keeps it through a rename", async () => {
    expect(await ownerForAccount("soundcloud", "100200300", "lumen", file)).toBe("lumen");
    expect(await ownerForAccount("soundcloud", "100200300", "aurora", file)).toBe("lumen");
  });

  it("gives a different account on a held handle a key of its own", async () => {
    await ownerForAccount("soundcloud", "100200300", "lumen", file);
    const other = await ownerForAccount("soundcloud", "200300400", "lumen", file);
    expect(other).toBe("lumen-200300400");
    expect(await ownerForAccount("soundcloud", "200300400", "lumen", file)).toBe(other);
  });

  it("keeps each source's accounts apart", async () => {
    await ownerForAccount("soundcloud", "100200300", "lumen", file);
    expect(await ownerForAccount("youtube", "100200300", "aurora", file)).toBe("aurora");
  });

  it("lets the handle decide when no id is known, and files nothing", async () => {
    expect(await ownerForAccount("soundcloud", undefined, "lumen", file)).toBe("lumen");
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("falls back to the handle when the registry can't be written", async () => {
    await fs.mkdir(file);
    expect(await ownerForAccount("soundcloud", "100200300", "lumen", file)).toBe("lumen");
  });
});

describe("ownerForHandle", () => {
  it("follows a renamed handle to the owner its account already had", async () => {
    await ownerForAccount("soundcloud", "100200300", "lumen", file);
    await ownerForAccount("soundcloud", "100200300", "aurora", file);
    expect(await ownerForHandle("soundcloud", "aurora", file)).toBe("lumen");
    expect(await ownerForHandle("soundcloud", "lumen", file)).toBe("lumen");
  });

  it("is the handle itself until that handle has been listed", async () => {
    expect(await ownerForHandle("soundcloud", "vesper", file)).toBe("vesper");
  });
});

describe("accountIdOf", () => {
  it("reads a SoundCloud user id only from a profile's own feed", () => {
    const entries: never[] = [];
    expect(
      accountIdOf("soundcloud", { id: "100200300", extractorKey: "SoundcloudUser", entries }),
    ).toBe("100200300");
    // A set's id is the set, not whoever made it.
    expect(
      accountIdOf("soundcloud", { id: "555", extractorKey: "SoundcloudSet", entries }),
    ).toBeUndefined();
  });

  it("reads a YouTube channel id of the right shape", () => {
    const entries: never[] = [];
    const channelId = `UC${"a".repeat(22)}`;
    expect(accountIdOf("youtube", { channelId, entries })).toBe(channelId);
    expect(accountIdOf("youtube", { channelId: "@lumen", entries })).toBeUndefined();
  });
});

describe("a renamed handle keeps its owner", () => {
  it("soundcloud", async () => {
    const profile = { id: "100200300", extractorKey: "SoundcloudUser" };
    enumerateMock.mockImplementation(async (url: string) =>
      url.endsWith("/likes")
        ? {
            ...profile,
            entries: [
              {
                id: "1",
                title: "Glass Hours",
                url: "https://soundcloud.com/tidewater/glass-hours",
                uploader: "Tidewater",
              },
            ],
          }
        : { ...profile, entries: [] },
    );

    const before = makeSoundcloud("lumen", file);
    await before.listPlaylists();
    expect(before.owner).toBe("lumen");

    const after = makeSoundcloud("aurora", file);
    const lists = await after.listPlaylists();
    expect(after.owner).toBe("lumen");
    const tracks = await after.listTracks(lists[0]!);
    expect(tracks.map((t) => t.owner)).toEqual(["lumen"]);
  });

  it("youtube", async () => {
    const channelId = `UC${"a".repeat(22)}`;
    enumerateMock.mockImplementation(async (url: string) =>
      url.endsWith("/playlists")
        ? { id: channelId, channelId, entries: [{ id: "PL1", title: "Night Drive" }] }
        : { title: "Night Drive", entries: [{ id: "v1", title: "Glass Hours" }] },
    );

    const before = makeYoutube("Lumen", file);
    await before.listPlaylists();
    expect(before.owner).toBe("lumen");

    const after = makeYoutube("AuroraTapes", file);
    const lists = await after.listPlaylists();
    expect(after.owner).toBe("lumen");
    const tracks = await after.listTracks(lists[0]!);
    expect(tracks.map((t) => t.owner)).toEqual(["lumen"]);
  });
});
