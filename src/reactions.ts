import { obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { errorCode } from "./errors.js";

export const REACTION_TOOL_NAME = "react_to_message";
export const EMOJI_SEARCH_TOOL_NAME = "emoji_search";

/**
 * A Slack emoji name after normalization: `eyes`, `white_check_mark`, `+1`, and every workspace
 * custom emoji, which are named the same way. Slack decides what exists; this only bounds the shape.
 */
const EMOJI_NAME = /^[a-z0-9_+-]{1,100}$/;
/** How many custom emoji names one lookup returns, and how many are kept for searching at all. */
const EMOJI_RESULTS = 40;
const EMOJI_CACHE_LIMIT = 4_000;
/** A workspace's emoji change rarely; a stale list is cheaper than a lookup on every call. */
const EMOJI_REFRESH_MS = 6 * 60 * 60 * 1000;

/** The message a reaction is attached to. The host derives it from the request; the model never does. */
export type ReactionTarget = { readonly channel: string; readonly ts: string };

/**
 * How a channel adds and removes an emoji reaction. `target` is the delivery target the request
 * already carries, so a member id resolves to its DM exactly as a reply would.
 */
export type ReactionHost = {
  react(target: string, ts: string, name: string, signal: AbortSignal): Promise<void>;
  unreact?(target: string, ts: string, name: string, signal: AbortSignal): Promise<void>;
};

/**
 * The emoji receipts a request receives: one while the run works, then the one that matches how it
 * ended — the reply delivered, the reply delivered but the run failed, or the reply never sent.
 */
export type ReceiptEmojis = {
  readonly working?: string;
  readonly done?: string;
  readonly failed?: string;
  readonly lost?: string;
};

/** What the workspace can react with. Only the channel knows the custom names it uploaded. */
export type EmojiSource = {
  list(signal: AbortSignal): Promise<readonly string[]>;
};

/**
 * Strips the colons a model often writes around an emoji name and folds case, then checks the shape.
 * `undefined` means the name is not something Slack could accept, so it is refused before the call.
 */
export function normalizeEmojiName(raw: string): string | undefined {
  const name = raw.trim().replace(/^:+|:+$/g, "").toLowerCase();
  return EMOJI_NAME.test(name) ? name : undefined;
}

/**
 * The inbound message of the request being answered right now. Requests are processed one at a time,
 * so the delivery loop is the only writer: it holds the anchor for the whole request and the model's
 * tool only reads it. Outside a request the anchor is undefined, which is what makes a reaction a
 * per-conversation act that can never land on somebody else's message.
 *
 * The same hold counts how many reactions the model has spent on that one message, so the cap is a
 * property of the request rather than of the process.
 */
export class ReactionAnchor {
  readonly #limit: number;
  #target: ReactionTarget | undefined;
  #used = 0;

  constructor(options: { readonly limit: number } = { limit: 3 }) {
    this.#limit = options.limit;
  }

  /** Sets the anchor and returns the restore step, so the caller can release it from a `finally`. */
  hold(target: ReactionTarget | undefined): () => void {
    const previous = this.#target;
    const previousUsed = this.#used;
    this.#target = target;
    this.#used = 0;
    return () => {
      this.#target = previous;
      this.#used = previousUsed;
    };
  }

  /** The message being answered, or undefined when no request is in flight. */
  peek(): ReactionTarget | undefined {
    return this.#target;
  }

  /** Reserves one reaction on the anchored message; false once this request reached its cap. */
  claim(): boolean {
    if (this.#used >= this.#limit) return false;
    this.#used += 1;
    return true;
  }
}

/**
 * The model's own way of answering with an emoji. The target comes from the anchor the host holds,
 * never from the arguments, so a reaction cannot be aimed at another conversation; the model only
 * chooses which emoji expresses the answer.
 */
export function createReactionExtension(options: {
  readonly host: ReactionHost;
  readonly anchor: ReactionAnchor;
  /** Absent when the channel cannot list its own emoji: only the standard names are usable then. */
  readonly emoji?: { readonly source: EmojiSource; readonly refreshMs?: number };
}): Extension {
  const { host, anchor } = options;
  const directory = options.emoji === undefined ? undefined : new EmojiDirectory(options.emoji.source, options.emoji.refreshMs);
  const react = defineTool({
    name: REACTION_TOOL_NAME,
    description: "React to the message you are answering with one Slack emoji — a tone of voice that needs no words."
      + " Any emoji the workspace has works: the whole Slack set (thumbsup, +1, -1, tada, heart, joy, fire, 100,"
      + " rocket, eyes, thinking_face, raised_hands, pray, sob, sweat_smile, mind_blown, white_check_mark, x,"
      + " warning…) and every custom emoji the team uploaded. Choose for the meaning — agreeing +1, disagreeing"
      + " -1, celebrating tada or 100, puzzling thinking_face, thanking pray — not for the shortest word."
      + " One call adds one emoji; a few in a row reads as a string, and one to three is livelier than a wall of"
      + " them. The reaction lands on the message that started this run, and it cannot explain anything, so"
      + " anything needing words still needs a reply."
      + (directory === undefined ? "" : " Use emoji_search to see which custom emoji this workspace has."),
    parameters: obj({
      emoji: str({
        minLength: 1,
        maxLength: 110,
        description: "Slack emoji name, with or without colons, e.g. tada, :tada:, or a custom emoji's name",
      }),
    }),
    // Re-adding the same reaction is a no-op on Slack, so replaying this call cannot double it.
    replay: "safe",
    execute: async (args, _api, context) => {
      const name = normalizeEmojiName(args.emoji);
      if (name === undefined) {
        return failure("INVALID_EMOJI_NAME", `"${args.emoji.slice(0, 64)}" is not a Slack emoji name;`
          + " use letters, digits, space-free - _ or +, such as tada.");
      }
      const target = anchor.peek();
      if (target === undefined) {
        return failure("NO_REACTION_TARGET", "No request is being answered, so there is no message to react to."
          + " A reaction only works while answering a message that arrived in a conversation.");
      }
      // The cap keeps a lively answer from becoming a wall of emoji; it is reset per request.
      if (!anchor.claim()) {
        return failure("REACTION_LIMIT_REACHED", "This message already has as many reactions as it is allowed."
          + " Put the rest of it in words.");
      }
      try {
        await host.react(target.channel, target.ts, name, context.abortSignal ?? new AbortController().signal);
        return {
          output: [{ type: "text", text: `Reacted with :${name}: to the message being answered.` }],
          details: { emoji: name },
        };
      } catch (error) {
        const code = errorCode(error);
        return failure(code, `The reaction was not added (${code}).`);
      }
    },
  });
  const search = directory === undefined ? undefined : defineTool({
    name: EMOJI_SEARCH_TOOL_NAME,
    description: "Look up which emoji this workspace can react with, including the custom ones it uploaded."
      + " With no query it lists a sample; with a word it returns the names containing it"
      + " (for example love, cat, party, slackbot). Names come back without colons.",
    parameters: obj({
      query: opt(str({ maxLength: 64, description: "Substring to look for in an emoji name" })),
    }),
    replay: "safe",
    execute: async (args, _api, context) => {
      const found = await directory.search(args.query, EMOJI_RESULTS,
        context.abortSignal ?? new AbortController().signal);
      if (found.names.length === 0) {
        // A missing scope is reported as itself: the standard emoji still work, the custom ones are unknown.
        return failure(found.error ?? "NO_EMOJI_MATCH", found.error === undefined
          ? `No emoji name contains "${(args.query ?? "").slice(0, 32)}".`
          : `The workspace's own emoji could not be listed (${found.error}); the standard Slack names still work.`);
      }
      return {
        output: [{
          type: "text",
          text: `${found.total} emoji; showing ${found.names.length}: ${found.names.join(", ")}`,
        }],
        details: { total: found.total, shown: found.names.length },
      };
    },
  });
  return defineExtension({
    name: "reactions",
    tools: search === undefined ? [react] : [react, search],
  });
}

/**
 * The workspace's emoji names, fetched once and refreshed when stale. A failure keeps whatever was
 * already known and is reported to the caller instead of thrown: not knowing the custom names costs
 * the model a vocabulary, it does not break the run.
 */
class EmojiDirectory {
  readonly #source: EmojiSource;
  readonly #refreshMs: number;
  #names: readonly string[] = [];
  #fetchedAt = 0;
  #error: string | undefined;

  constructor(source: EmojiSource, refreshMs = EMOJI_REFRESH_MS) {
    this.#source = source;
    this.#refreshMs = refreshMs;
  }

  async search(query: string | undefined, limit: number, signal: AbortSignal): Promise<{
    readonly names: readonly string[];
    readonly total: number;
    readonly error?: string;
  }> {
    await this.#refresh(signal);
    const needle = query?.trim().toLowerCase().replace(/^:+|:+$/g, "") ?? "";
    const matching = needle === "" ? this.#names : this.#names.filter((name) => name.includes(needle));
    return {
      names: matching.slice(0, limit),
      total: matching.length,
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
  }

  async #refresh(signal: AbortSignal): Promise<void> {
    const stale = Date.now() - this.#fetchedAt >= this.#refreshMs;
    const empty = this.#names.length === 0;
    if (!stale && !empty) return;
    try {
      const names = await this.#source.list(signal);
      // Names arrive sorted by Slack; a bounded list keeps a pathological workspace from bloating a result.
      this.#names = names.slice(0, EMOJI_CACHE_LIMIT);
      this.#fetchedAt = Date.now();
      this.#error = undefined;
    } catch (error) {
      this.#error = errorCode(error);
      // Back off to the refresh interval as well: a missing scope will not fix itself in a second.
      this.#fetchedAt = Date.now();
    }
  }
}

function failure(code: string, message: string): ToolExecutionResult {
  return {
    isError: true,
    output: [{ type: "text", text: message }],
    details: { code },
    diagnostics: [{ severity: "error", code, message }],
  };
}
