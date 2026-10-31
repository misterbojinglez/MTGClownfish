// Wire types for the Forge bridge (see bridge/src/main/java/tabletop/bridge).

export type ZoneName = 'Battlefield' | 'Graveyard' | 'Exile' | 'Command' | 'Hand' | 'Library' | 'Stack';

export interface CardState {
  id: number;
  owner: number | null;
  controller: number | null;
  zone: ZoneName | null;
  tapped: boolean;
  visible: boolean;
  name?: string;
  set?: string;
  cn?: string | null;
  imageKey?: string;
  faceDown?: boolean;
  state?: string;
  token?: boolean;
  commander?: boolean;
  sick?: boolean;
  attacking?: boolean;
  blocking?: boolean;
  damage?: number;
  manaCost?: string;
  typeLine?: string;
  text?: string;
  creature?: boolean;
  land?: boolean;
  planeswalker?: boolean;
  /** a creature with flying (hovers above the table) */
  flying?: boolean;
  /** keywords worth showing on the battlefield (Haste, Vigilance, Trample…) */
  keywords?: string[];
  /** a creature that couldn't block even untapped (Gravecrawler, "can't block this turn") */
  cantBlock?: boolean;
  power?: number;
  toughness?: number;
  /** battlefield creatures: P/T before counters and other modifiers (printed, or set by an effect) */
  basePower?: number;
  baseToughness?: number;
  /** how much of the P/T comes from counters (present only when non-zero) */
  counterPower?: number;
  counterToughness?: number;
  loyalty?: string;
  counters?: Record<string, number>;
  attachedTo?: number | null;
  colors?: string;
}

export interface PlayerState {
  id: number;
  name: string;
  ai: boolean;
  life: number;
  /** mana they could make right now: untapped sources (net of activation costs) plus floating mana */
  manaAvailable?: number;
  /** turns this player has started (the game's turn number counts everyone's) */
  turns?: number;
  lost: boolean;
  priority: boolean;
  poison: number;
  counters: Record<string, number>;
  mana: Record<string, number>;
  zones: {
    Battlefield: number[];
    Graveyard: number[];
    Exile: number[];
    Command: number[];
    Hand: number[];
    LibraryCount: number;
  };
  commanderDamage?: Record<string, number>;
  commanders?: number[];
}

export type Ref = { card?: number; player?: number; stack?: number; entity?: number; ability?: number } | null;

export interface StackItem {
  id: number;
  text: string;
  source: number | null;
  controller: number | null;
  ability: boolean;
  trigger: boolean;
  targets: Ref[];
}

export interface Attack {
  attacker: number;
  defender: Ref;
  blockers: number[];
}

export interface GameState {
  turn: number;
  phase: string | null;
  activePlayer: number | null;
  gameOver: boolean;
  winner: string | null;
  commander: boolean;
  mulligan: boolean;
  players: PlayerState[];
  stack: StackItem[];
  combat: Attack[] | null;
  cards: Record<string, CardState>;
}

export interface Button {
  label: string;
  enabled: boolean;
  focus?: boolean;
}

/** The spell or ability resolving while the engine asks something, so the question has context. */
export interface ResolvingSource {
  card: number | null;
  name: string | null;
  /** the stack text, e.g. "Preordain - Scry 2, then draw a card." */
  text: string | null;
  ability: boolean;
  trigger: boolean;
  controller: number | null;
}

export interface Prompt {
  message: string;
  card?: number | null;
  ok?: Button;
  cancel?: Button;
  /** Forge input class behind this prompt, e.g. InputPassPriority, InputPayManaOfCostPayment */
  input?: string | null;
  /** which Forge input object this is: a new number for each prompt (the same one while you pick several cards) */
  inputId?: number;
  source?: ResolvingSource | null;
}

export interface Selection {
  cards: number[];
  min: number;
  max: number;
  targets: Ref[];
  chosen: Ref[];
  actionable: number[];
}

export interface GameEvent {
  event: string;
  [key: string]: unknown;
}

export interface UpdateMsg {
  type: 'update';
  seq: number;
  events: GameEvent[];
  state: GameState;
  prompt: Prompt;
  selection: Selection;
}

export interface ChoiceOption {
  label: string;
  card?: number;
  /** the card's details when it comes from a zone the client doesn't track (library, hidden hand) */
  cardData?: CardState;
  /** distribute: the most this option may receive */
  max?: number;
  /** distribute: a mana colour (W/U/B/R/G/C) rather than a game object */
  color?: string;
  ability?: number;
  player?: number;
  entity?: number;
}

export interface RequestMsg {
  type: 'request';
  id: number;
  kind: 'choose' | 'reveal' | 'order' | 'confirm' | 'input' | 'distribute';
  /** distribute: total to divide, and whether every option needs at least one */
  amount?: number;
  atLeastOne?: boolean;
  message?: string;
  caption?: string;
  card?: number | null;
  min?: number;
  max?: number;
  minRemaining?: number;
  maxRemaining?: number;
  options?: ChoiceOption[];
  buttons?: string[];
  initial?: string | null;
  numeric?: boolean;
  source?: ResolvingSource | null;
}

/** The engine's reading of a pasted deck list. */
export interface DeckInfo {
  type: 'deckInfo';
  id: number;
  ok: boolean;
  /** a commander list that doesn't say which card leads it */
  needsCommander: boolean;
  name?: string;
  /** main deck size (commanders not included) */
  count?: number;
  commanders?: string[];
  colors?: string[];
  face?: { name: string; set: string; cn: string };
  unknown: string[];
  warnings: string[];
  /** legendary cards in the main deck that could be its commander */
  candidates: string[];
  /** why the deck isn't format-legal (it can still be played) */
  problem?: string;
}

/** One seat's deck when starting a game: a pasted list, or null for a random precon. */
/** a pasted list, or one of Forge's precons by name */
export type SeatDeckSpec = { list: string; name?: string; commanders?: string[] } | { precon: string };

/** one of Forge's precon decks, for the deck picker */
export interface PreconInfo {
  name: string;
  commanders: string[];
  colors: string[];
  face?: { name: string; set: string; cn: string };
}

export type ServerMsg =
  | UpdateMsg
  | RequestMsg
  | { type: 'starting'; format: string; decks: string[] }
  | { type: 'gameStarted'; you: number[] }
  | { type: 'notice'; kind: string; text: string | null }
  | { type: 'pong' }
  | DeckInfo
  | { type: 'precons'; format: string; decks: PreconInfo[] };

export type Action =
  /** auto: the client's own auto-pay (the bridge won't let it sacrifice a mana source) */
  | { action: 'ok'; auto?: boolean }
  | { action: 'cancel' | 'alphaStrike' | 'undo' | 'concede' }
  /** turn: the turn the client is showing, so a late click can't carry into the next turn */
  | { action: 'passUntilEndOfTurn'; turn?: number }
  | { action: 'card'; id: number; button?: number }
  | { action: 'player'; id: number; button?: number }
  | { action: 'stack'; id: number }
  | { action: 'mana'; color: number }
  | { action: 'reorderHand'; id: number; index: number };
