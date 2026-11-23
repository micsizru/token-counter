'use strict';

/**
 * Lightweight, zero-dependency protobuf wire decoder and Antigravity metadata parsers.
 * Safe against truncated or mid-write buffers (never throws unhandled exceptions).
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_START_GROUP = 3;
const WIRE_END_GROUP = 4;
const WIRE_32BIT = 5;

const MAX_VARINT_BYTES = 10;

/**
 * Read an unsigned base-128 varint as BigInt starting at `pos` up to `end`.
 * Returns `{ value: BigInt, nextPos: number }` or `null` if truncated/malformed.
 *
 * @param {Buffer|Uint8Array} buf
 * @param {number} pos
 * @param {number} end
 * @returns {{ value: bigint, nextPos: number } | null}
 */
function readVarint(buf, pos, end) {
  let value = 0n;
  let shift = 0n;
  let count = 0;

  while (pos < end && count < MAX_VARINT_BYTES) {
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextPos: pos };
    }
    shift += 7n;
    count += 1;
  }

  return null;
}

/**
 * Decode all top-level protobuf fields in `[start, end)` of `buffer`.
 * Bounds-checked and tolerant of truncated/corrupted tails.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {number} [start=0]
 * @param {number} [end]
 * @returns {Array<{ field: number, wire: number, value: bigint | Buffer }>}
 */
function decodeFields(buffer, start, end) {
  if (!buffer || typeof buffer.length !== 'number') {
    return [];
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let pos = typeof start === 'number' && start > 0 ? start : 0;
  const limit = typeof end === 'number' && end < buf.length ? end : buf.length;
  if (pos >= limit) {
    return [];
  }

  const fields = [];

  while (pos < limit) {
    const tagRes = readVarint(buf, pos, limit);
    if (!tagRes) {
      break;
    }
    pos = tagRes.nextPos;

    const fieldBig = tagRes.value >> 3n;
    const wire = Number(tagRes.value & 7n);
    if (fieldBig <= 0n || fieldBig > 536870911n) {
      break;
    }
    const field = Number(fieldBig);

    if (wire === WIRE_VARINT) {
      const valRes = readVarint(buf, pos, limit);
      if (!valRes) {
        break;
      }
      pos = valRes.nextPos;
      fields.push({ field, wire, value: valRes.value });
    } else if (wire === WIRE_64BIT) {
      if (pos + 8 > limit) {
        break;
      }
      fields.push({ field, wire, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === WIRE_LENGTH_DELIMITED) {
      const lenRes = readVarint(buf, pos, limit);
      if (!lenRes) {
        break;
      }
      pos = lenRes.nextPos;
      if (lenRes.value < 0n || lenRes.value > BigInt(limit - pos)) {
        break;
      }
      const len = Number(lenRes.value);
      fields.push({ field, wire, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === WIRE_32BIT) {
      if (pos + 4 > limit) {
        break;
      }
      fields.push({ field, wire, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else if (wire === WIRE_START_GROUP || wire === WIRE_END_GROUP) {
      break;
    } else {
      break;
    }
  }

  return fields;
}

/**
 * Convert a BigInt varint to a safe non-negative JS Number, or 0 if out of range.
 *
 * @param {bigint} big
 * @returns {number}
 */
function safeBigIntToNumber(big) {
  if (typeof big !== 'bigint') {
    return 0;
  }
  if (big < 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    return 0;
  }
  return Number(big);
}

/**
 * Decode a protobuf google.protobuf.Timestamp (`f1 = seconds`, `f2 = nanos`) to epoch ms.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {number}
 */
function parseTimestampMs(buf) {
  if (!buf || buf.length === 0) {
    return 0;
  }
  const fields = decodeFields(buf);
  let seconds = 0;
  let nanos = 0;

  for (const f of fields) {
    if (f.field === 1 && f.wire === WIRE_VARINT) {
      seconds = safeBigIntToNumber(f.value);
    } else if (f.field === 2 && f.wire === WIRE_VARINT) {
      nanos = safeBigIntToNumber(f.value);
    }
  }

  if (seconds <= 0) {
    return 0;
  }
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

/**
 * Convert a file:// URI (including percent-encoded Windows drive colons like `file:///c%3A/...`)
 * into a filesystem path string.
 *
 * @param {string} uri
 * @returns {string}
 */
function uriToFsPath(uri) {
  if (!uri || typeof uri !== 'string') {
    return '';
  }
  const trimmed = uri.trim();
  if (!trimmed) {
    return '';
  }
  if (!trimmed.toLowerCase().startsWith('file://')) {
    return trimmed;
  }

  let rest = trimmed.slice('file://'.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Keep raw string if percent-encoding is malformed
  }

  // file:///c:/foo or file:///C:/foo -> c:/foo
  if (/^\/[a-zA-Z]:[\\/]/.test(rest)) {
    rest = rest.slice(1);
  } else if (/^\/[a-zA-Z]:$/.test(rest)) {
    rest = rest.slice(1);
  } else if (!rest.startsWith('/')) {
    // UNC path: file://server/share -> //server/share
    rest = '//' + rest;
  }

  if (process.platform === 'win32') {
    return rest.replace(/\//g, '\\');
  }
  return rest;
}

/**
 * Map summary status varint to canonical string.
 * Verified on live agyhub_summaries_proto.pb: 1 = IDLE, 2 = RUNNING.
 *
 * @param {bigint} val
 * @returns {'idle' | 'running' | 'unknown'}
 */
function mapStatus(val) {
  if (val === 1n) {
    return 'idle';
  }
  if (val === 2n) {
    return 'running';
  }
  return 'unknown';
}

/**
 * Decode `agyhub_summaries_proto.pb` into an array of conversation summary objects.
 *
 * Verified schema on Antigravity IDE 2.8.0:
 *   Top-level repeated f1 (len-delim): Entry {
 *     f1 (string): conversation UUID
 *     f2 (len-delim): Summary {
 *       f1 (string): title
 *       f2 (varint): stepCount
 *       f3 (Timestamp): lastModifiedTime
 *       f5 (varint): status (1=idle, 2=running)
 *       f9 (len-delim): Workspace { f1 (string): workspaceUri }
 *       f10 (Timestamp): lastUserInputTime
 *       f15 (len-delim): AnnotationSummary { f1 (string): title, f7 (Timestamp): lastUserViewTime }
 *       f17 (len-delim): TrajectoryInfo {
 *         f1 (len-delim): { f1 (string): workspaceUri }
 *         f5 (string): parentConversationId (non-empty only on subagents/swarm workers)
 *         f7 (string): encodedWorkspaceUri
 *         f17 (varint): nestingDepth
 *       }
 *     }
 *   }
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Array<{
 *   id: string,
 *   title: string,
 *   stepCount: number,
 *   lastModifiedMs: number,
 *   status: 'idle' | 'running' | 'unknown',
 *   workspaceUri: string,
 *   workspacePath: string,
 *   lastUserInputMs: number,
 *   lastUserViewMs: number,
 *   parentConversationId: string,
 *   nestingDepth: number
 * }>}
 */
function parseSummariesProto(buffer) {
  if (!buffer || buffer.length === 0) {
    return [];
  }

  const results = [];
  const topFields = decodeFields(buffer);

  for (const entryField of topFields) {
    if (entryField.field !== 1 || entryField.wire !== WIRE_LENGTH_DELIMITED) {
      continue;
    }

    const entrySub = decodeFields(entryField.value);
    let id = '';
    let summaryBuf = null;

    for (const ef of entrySub) {
      if (ef.field === 1 && ef.wire === WIRE_LENGTH_DELIMITED) {
        id = ef.value.toString('utf8').trim();
      } else if (ef.field === 2 && ef.wire === WIRE_LENGTH_DELIMITED) {
        summaryBuf = ef.value;
      }
    }

    if (!id) {
      continue;
    }

    let title = '';
    let annotationTitle = '';
    let stepCount = 0;
    let lastModifiedMs = 0;
    let status = 'unknown';
    let workspaceUri = '';
    let fallbackWorkspaceUri = '';
    let lastUserInputMs = 0;
    let lastUserViewMs = 0;
    let parentConversationId = '';
    let nestingDepth = 0;

    if (summaryBuf && summaryBuf.length > 0) {
      const sFields = decodeFields(summaryBuf);

      for (const sf of sFields) {
        if (sf.field === 1 && sf.wire === WIRE_LENGTH_DELIMITED) {
          title = sf.value.toString('utf8').trim();
        } else if (sf.field === 2 && sf.wire === WIRE_VARINT) {
          stepCount = safeBigIntToNumber(sf.value);
        } else if (sf.field === 3 && sf.wire === WIRE_LENGTH_DELIMITED) {
          lastModifiedMs = parseTimestampMs(sf.value);
        } else if (sf.field === 5 && sf.wire === WIRE_VARINT) {
          status = mapStatus(sf.value);
        } else if (sf.field === 9 && sf.wire === WIRE_LENGTH_DELIMITED) {
          if (!workspaceUri) {
            const wsFields = decodeFields(sf.value);
            for (const wf of wsFields) {
              if (wf.field === 1 && wf.wire === WIRE_LENGTH_DELIMITED) {
                const candidate = wf.value.toString('utf8').trim();
                if (candidate) {
                  workspaceUri = candidate;
                  break;
                }
              }
            }
          }
        } else if (sf.field === 10 && sf.wire === WIRE_LENGTH_DELIMITED) {
          lastUserInputMs = parseTimestampMs(sf.value);
        } else if (sf.field === 15 && sf.wire === WIRE_LENGTH_DELIMITED) {
          const annFields = decodeFields(sf.value);
          for (const af of annFields) {
            if (af.field === 1 && af.wire === WIRE_LENGTH_DELIMITED && !annotationTitle) {
              annotationTitle = af.value.toString('utf8').trim();
            } else if (af.field === 7 && af.wire === WIRE_LENGTH_DELIMITED) {
              const viewMs = parseTimestampMs(af.value);
              if (viewMs > lastUserViewMs) {
                lastUserViewMs = viewMs;
              }
            }
          }
        } else if (sf.field === 17 && sf.wire === WIRE_LENGTH_DELIMITED) {
          const trajFields = decodeFields(sf.value);
          for (const tf of trajFields) {
            if (tf.field === 1 && tf.wire === WIRE_LENGTH_DELIMITED && !fallbackWorkspaceUri) {
              const subWs = decodeFields(tf.value);
              for (const swf of subWs) {
                if (swf.field === 1 && swf.wire === WIRE_LENGTH_DELIMITED) {
                  const candidate = swf.value.toString('utf8').trim();
                  if (candidate) {
                    fallbackWorkspaceUri = candidate;
                    break;
                  }
                }
              }
            } else if (tf.field === 5 && tf.wire === WIRE_LENGTH_DELIMITED) {
              parentConversationId = tf.value.toString('utf8').trim();
            } else if (tf.field === 7 && tf.wire === WIRE_LENGTH_DELIMITED && !fallbackWorkspaceUri) {
              const candidate = tf.value.toString('utf8').trim();
              if (candidate) {
                fallbackWorkspaceUri = candidate;
              }
            } else if (tf.field === 17 && tf.wire === WIRE_VARINT) {
              nestingDepth = safeBigIntToNumber(tf.value);
            }
          }
        }
      }
    }

    const finalWorkspaceUri = workspaceUri || fallbackWorkspaceUri;

    results.push({
      id,
      title: title || annotationTitle || '',
      stepCount,
      lastModifiedMs,
      status,
      workspaceUri: finalWorkspaceUri,
      workspacePath: uriToFsPath(finalWorkspaceUri),
      lastUserInputMs,
      lastUserViewMs,
      parentConversationId,
      nestingDepth,
    });
  }

  return results;
}

/**
 * Decode `executor_metadata.data` protobuf from `conversations/<uuid>.db`
 * and extract the auto-compaction context budget at `f10.f2.f5` (e.g. 256000, 512000, 128000).
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {number | null}
 */
function parseExecutorContextBudget(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  const topFields = decodeFields(buffer);
  for (const f10 of topFields) {
    if (f10.field !== 10 || f10.wire !== WIRE_LENGTH_DELIMITED) {
      continue;
    }
    const f10Fields = decodeFields(f10.value);
    for (const f2 of f10Fields) {
      if (f2.field !== 2 || f2.wire !== WIRE_LENGTH_DELIMITED) {
        continue;
      }
      const f2Fields = decodeFields(f2.value);
      for (const f5 of f2Fields) {
        if (f5.field === 5 && f5.wire === WIRE_VARINT) {
          const budget = safeBigIntToNumber(f5.value);
          if (budget > 0) {
            return budget;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Decode `gen_metadata.data` protobuf from `conversations/<uuid>.db`
 * and extract the human-readable model display name at `f1.f21` (e.g. "Gemini 4 Neon (High)").
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {string | null}
 */
function parseGenModelDisplayName(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  const topFields = decodeFields(buffer);
  for (const f1 of topFields) {
    if (f1.field !== 1 || f1.wire !== WIRE_LENGTH_DELIMITED) {
      continue;
    }
    const f1Fields = decodeFields(f1.value);
    for (const f21 of f1Fields) {
      if (f21.field === 21 && f21.wire === WIRE_LENGTH_DELIMITED) {
        const name = f21.value.toString('utf8').trim();
        if (name) {
          return name;
        }
      }
    }
  }

  return null;
}

/**
 * Decode `gen_metadata.data` protobuf from `conversations/<uuid>.db`
 * and extract token usage from `f1.f4`:
 *   f2 = inputTokens, f3 = outputTokens, f5 = cacheReadTokens,
 *   f9 = thinkingTokens, f10 = visibleOutputTokens.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   thinkingTokens: number,
 *   visibleOutputTokens: number,
 *   hasThinkingField: boolean
 * } | null}
 */
function parseGenMetadataUsage(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  const topFields = decodeFields(buffer);
  for (const f1 of topFields) {
    if (f1.field !== 1 || f1.wire !== WIRE_LENGTH_DELIMITED) {
      continue;
    }
    const f1Fields = decodeFields(f1.value);
    for (const f4 of f1Fields) {
      if (f4.field !== 4 || f4.wire !== WIRE_LENGTH_DELIMITED) {
        continue;
      }
      const usageFields = decodeFields(f4.value);
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let f9 = 0;
      let f10 = 0;
      let hasF9 = false;
      let hasF10 = false;

      for (const uf of usageFields) {
        if (uf.wire !== WIRE_VARINT) {
          continue;
        }
        const val = safeBigIntToNumber(uf.value);
        if (uf.field === 2) {
          inputTokens = val;
        } else if (uf.field === 3) {
          outputTokens = val;
        } else if (uf.field === 5) {
          cacheReadTokens = val;
        } else if (uf.field === 9) {
          f9 = val;
          hasF9 = true;
        } else if (uf.field === 10) {
          f10 = val;
          hasF10 = true;
        }
      }

      const hasThinkingField = hasF9 || hasF10;
      const thinkingTokens = hasThinkingField ? f9 : 0;
      const visibleOutputTokens = hasThinkingField
        ? (hasF10 ? f10 : Math.max(0, outputTokens - f9))
        : outputTokens;

      return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        thinkingTokens,
        visibleOutputTokens,
        hasThinkingField,
      };
    }
  }

  return null;
}

/**
 * Parse an `annotations/<uuid>.pbtxt` text-proto file for `last_user_view_time` and `title`.
 *
 * @param {string} text
 * @returns {{ lastUserViewMs: number, title: string }}
 */
function parseAnnotationPbtxt(text) {
  if (!text || typeof text !== 'string') {
    return { lastUserViewMs: 0, title: '' };
  }

  let lastUserViewMs = 0;
  const viewMatch = text.match(/last_user_view_time\s*:\s*\{([^}]*)\}/);
  if (viewMatch) {
    const body = viewMatch[1];
    const secMatch = body.match(/seconds\s*:\s*(\d+)/);
    const nanosMatch = body.match(/nanos\s*:\s*(\d+)/);
    const seconds = secMatch ? Number(secMatch[1]) : 0;
    const nanos = nanosMatch ? Number(nanosMatch[1]) : 0;
    if (Number.isFinite(seconds) && seconds > 0) {
      lastUserViewMs = seconds * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1e6);
    }
  }

  let title = '';
  const titleMatch = text.match(/(?:^|\s)title\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (titleMatch) {
    try {
      title = JSON.parse('"' + titleMatch[1] + '"').trim();
    } catch {
      title = titleMatch[1].trim();
    }
  }

  return { lastUserViewMs, title };
}

module.exports = {
  WIRE_VARINT,
  WIRE_64BIT,
  WIRE_LENGTH_DELIMITED,
  WIRE_32BIT,
  readVarint,
  decodeFields,
  parseTimestampMs,
  uriToFsPath,
  parseSummariesProto,
  parseExecutorContextBudget,
  parseGenModelDisplayName,
  parseGenMetadataUsage,
  parseAnnotationPbtxt,
};
