/**
 * A binary property list reader, and the NSKeyedArchiver graph on top of it.
 *
 * Needed because the interesting parts of chat.db are not columns. A rich link
 * preview — the title, the site, the summary — is an `LPLinkMetadata` object
 * archived into `message.payload_data`, and an edited message keeps its older
 * versions inside `message_summary_info`. Both are `bplist00`.
 *
 * Written by hand rather than shelling out to `plutil`, for two reasons: the
 * project has no dependencies and shouldn't grow one, and `plutil` costs a
 * process per blob — 19,566 of them for links alone in one library. Its `-p`
 * output is also not machine-readable, and `-convert json` chokes on archiver
 * UIDs, so parsing its output would be its own source of bugs.
 *
 * Format reference: CFBinaryPlist. Header "bplist00", a trailer in the last 32
 * bytes giving the offset table, then typed objects addressed by index.
 *
 * Validate any change with `node bin/check-bplist.mjs`, which compares this
 * parser against `plutil` on real payloads from the database.
 */

const HEADER = "bplist00";

/** A keyed-archiver UID. Distinct from a number so the graph walker can tell. */
class UID {
  constructor(n) { this.uid = n; }
}

/**
 * Parse a binary plist.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {unknown} plain JS: objects, arrays, strings, numbers, Date, Buffer
 */
export function parseBplist(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 40 || b.subarray(0, 8).toString("latin1") !== HEADER) {
    throw new Error("not a binary plist");
  }

  // Trailer: 6 unused, sortVersion, offsetIntSize, objectRefSize, then three
  // 64-bit counts. Only the last 32 bytes matter.
  const t = b.length - 32;
  const offsetSize = b[t + 6];
  const refSize = b[t + 7];
  const numObjects = readBig(b, t + 8, 8);
  const topObject = readBig(b, t + 16, 8);
  const tableOffset = readBig(b, t + 24, 8);

  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) {
    throw new Error("bad bplist trailer");
  }
  // The trailer's counts come from the blob, and the blob can be corrupt: a
  // damaged trailer claiming 10^12 objects made `new Array(numObjects)` OOM
  // the whole process (found by fuzzing). Every count must fit the bytes that
  // are actually here before it is believed.
  if (numObjects === 0 || tableOffset + numObjects * offsetSize > t) {
    throw new Error("bplist trailer inconsistent with file size");
  }
  if (topObject >= numObjects) throw new Error("bplist top object out of range");

  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i += 1) {
    const off = readBig(b, tableOffset + i * offsetSize, offsetSize);
    if (off >= t) throw new Error("bplist object offset out of range");
    offsets[i] = off;
  }

  // Objects can reference each other; a malformed file could cycle. Parsing is
  // memoised, which also stops a shared object being decoded a hundred times.
  const cache = new Map();
  const parseAt = (index) => {
    if (index >= numObjects) throw new Error("object index out of range");
    if (cache.has(index)) return cache.get(index);
    cache.set(index, null);                       // placeholder breaks cycles
    const v = readObject(b, offsets[index], refSize, parseAt);
    cache.set(index, v);
    return v;
  };

  return parseAt(topObject);
}

function readBig(b, at, size) {
  let n = 0;
  for (let i = 0; i < size; i += 1) n = n * 256 + b[at + i];
  return n;
}

/**
 * A declared length must fit inside the bytes that exist. Corrupt blobs claim
 * container sizes in the billions; believing one allocates until the process
 * dies, so every variable-length object checks before it reads.
 */
function fits(b, at, bytes) {
  if (bytes < 0 || at + bytes > b.length) throw new Error("bplist length exceeds file size");
}

/** Length nibble: 0xF means "an integer object follows with the real length". */
function readLength(b, at, low) {
  if (low !== 0xF) return { len: low, next: at + 1 };
  const marker = b[at + 1];
  if ((marker & 0xF0) !== 0x10) throw new Error("bad length marker");
  const bytes = 2 ** (marker & 0x0F);
  return { len: readBig(b, at + 2, bytes), next: at + 2 + bytes };
}

function readObject(b, at, refSize, parseAt) {
  const marker = b[at];
  const type = marker >> 4;
  const low = marker & 0x0F;

  switch (type) {
    case 0x0:
      if (low === 0) return null;
      if (low === 8) return false;
      if (low === 9) return true;
      if (low === 15) return null;                // fill byte
      throw new Error(`unknown singleton 0x0${low.toString(16)}`);

    case 0x1: {                                    // int, 2^low bytes, signed if 16
      const size = 2 ** low;
      if (size === 16) {
        // 128-bit ints appear in the wild only as large counters; the low 64
        // bits are all anything here needs, and BigInt would leak into callers.
        return readBig(b, at + 9, 8);
      }
      const n = readBig(b, at + 1, size);
      // 8-byte integers are signed in this format; smaller ones are not.
      return size === 8 && n > 2 ** 63 ? n - 2 ** 64 : n;
    }

    case 0x2:                                      // real
      return low === 2 ? b.readFloatBE(at + 1) : b.readDoubleBE(at + 1);

    case 0x3:                                      // date: seconds since 2001-01-01
      return new Date((b.readDoubleBE(at + 1) + 978307200) * 1000);

    case 0x4: {                                    // data
      const { len, next } = readLength(b, at, low);
      fits(b, next, len);
      return b.subarray(next, next + len);
    }

    case 0x5: {                                    // ASCII
      const { len, next } = readLength(b, at, low);
      fits(b, next, len);
      return b.subarray(next, next + len).toString("latin1");
    }

    case 0x6: {                                    // UTF-16BE
      const { len, next } = readLength(b, at, low);
      fits(b, next, len * 2);
      // Buffer.from(), not subarray(): subarray is a *view* onto the same
      // memory and swap16() mutates in place, so decoding a string used to
      // corrupt the blob being parsed. Every later read then returned
      // byte-swapped garbage, and the caller's buffer was damaged too.
      return Buffer.from(b.subarray(next, next + len * 2)).swap16().toString("utf16le");
    }

    case 0x8:                                      // UID, low+1 bytes
      return new UID(readBig(b, at + 1, low + 1));

    case 0xA:
    case 0xC: {                                    // array, set
      const { len, next } = readLength(b, at, low);
      fits(b, next, len * refSize);
      const out = [];
      for (let i = 0; i < len; i += 1) out.push(parseAt(readBig(b, next + i * refSize, refSize)));
      return out;
    }

    case 0xD: {                                    // dict
      const { len, next } = readLength(b, at, low);
      fits(b, next, len * refSize * 2);
      const out = {};
      for (let i = 0; i < len; i += 1) {
        const k = parseAt(readBig(b, next + i * refSize, refSize));
        const v = parseAt(readBig(b, next + len * refSize + i * refSize, refSize));
        out[String(k)] = v;
      }
      return out;
    }

    default:
      throw new Error(`unknown bplist type 0x${type.toString(16)}`);
  }
}

/**
 * Resolve an NSKeyedArchiver graph into plain values.
 *
 * The archive is a flat `$objects` array where every reference is a UID index
 * into it, so the shape you want is spread across the array rather than
 * nested. This walks it, replacing UIDs with the objects they point at and
 * dropping the `$class` bookkeeping.
 *
 * `depth` guards against the graph being deeper than anything real — these
 * archives nest a handful of levels, not a hundred.
 */
export function unarchive(root, { depth = 24 } = {}) {
  if (!root || typeof root !== "object" || !Array.isArray(root.$objects)) return root;
  const objects = root.$objects;
  const seen = new Set();

  const walk = (v, left) => {
    if (left <= 0) return null;
    if (v instanceof UID) {
      if (seen.has(v.uid)) return null;            // cycle
      seen.add(v.uid);
      const out = walk(objects[v.uid], left - 1);
      seen.delete(v.uid);
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, left - 1));
    if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === "$class") continue;
        out[k] = walk(val, left - 1);
      }
      return out;
    }
    return v;                                       // "$null" stays a string
  };

  const top = root.$top && typeof root.$top === "object" ? root.$top.root ?? root.$top : root;
  return walk(top, depth);
}

/** Parse and unarchive in one step, the way every caller here wants it. */
export function readArchive(buf, opts) {
  return unarchive(parseBplist(buf), opts);
}

export { UID };
