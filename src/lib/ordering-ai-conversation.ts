import type { ServiceType } from "@/lib/ordering-core";

export type FulfillmentQuestionState =
  | "not_asked"
  | "asked_unanswered"
  | "deferred_while_ordering"
  | "resolved";

export type AiFulfillmentState = {
  serviceType: ServiceType;
  questionState: FulfillmentQuestionState;
  itemsCapturedSinceQuestion: number;
};

export type AiFulfillmentTurnInput = {
  state: AiFulfillmentState;
  explicitServiceType?: Exclude<ServiceType, "undecided"> | null;
  customerStartedOrdering?: boolean;
  itemBoundaryReached?: boolean;
  readyToConfirm?: boolean;
};

export type AiFulfillmentDirective =
  | "none"
  | "ask_now"
  | "continue_order_then_reask"
  | "reask_at_natural_break"
  | "block_confirmation_and_ask";

export type AiFulfillmentTurnResult = {
  state: AiFulfillmentState;
  directive: AiFulfillmentDirective;
  suggestedPrompt: string;
};

export function newAiFulfillmentState(): AiFulfillmentState {
  return {
    serviceType: "undecided",
    questionState: "not_asked",
    itemsCapturedSinceQuestion: 0,
  };
}

/**
 * The AI should not fight the customer over conversational order. If the AI
 * asks pickup/delivery and the customer immediately starts ordering, capture
 * the order content first. Fulfillment remains a required field and is asked
 * again at the next natural item boundary or before confirmation.
 */
export function advanceAiFulfillmentTurn(input: AiFulfillmentTurnInput): AiFulfillmentTurnResult {
  const state: AiFulfillmentState = { ...input.state };

  if (input.explicitServiceType) {
    state.serviceType = input.explicitServiceType;
    state.questionState = "resolved";
    state.itemsCapturedSinceQuestion = 0;
    return { state, directive: "none", suggestedPrompt: "" };
  }

  if (state.serviceType !== "undecided") {
    state.questionState = "resolved";
    return { state, directive: "none", suggestedPrompt: "" };
  }

  if (input.readyToConfirm) {
    state.questionState = "asked_unanswered";
    return {
      state,
      directive: "block_confirmation_and_ask",
      suggestedPrompt: "Before I send that in, is this for pickup or delivery?",
    };
  }

  if (state.questionState === "not_asked") {
    if (input.customerStartedOrdering) {
      state.questionState = "deferred_while_ordering";
      state.itemsCapturedSinceQuestion = 1;
      return {
        state,
        directive: "continue_order_then_reask",
        suggestedPrompt: "",
      };
    }
    state.questionState = "asked_unanswered";
    return {
      state,
      directive: "ask_now",
      suggestedPrompt: "Will this be for pickup or delivery?",
    };
  }

  if (input.customerStartedOrdering) {
    state.questionState = "deferred_while_ordering";
    state.itemsCapturedSinceQuestion += 1;
    return {
      state,
      directive: "continue_order_then_reask",
      suggestedPrompt: "",
    };
  }

  if (state.questionState === "deferred_while_ordering" && input.itemBoundaryReached) {
    state.questionState = "asked_unanswered";
    return {
      state,
      directive: "reask_at_natural_break",
      suggestedPrompt: "Got that. Is the order for pickup or delivery?",
    };
  }

  return { state, directive: "none", suggestedPrompt: "" };
}
