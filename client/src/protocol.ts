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
  power?: number;
  toughness?: number;
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

export type ServerMsg =
  | UpdateMsg
  | RequestMsg
  | { type: 'starting'; format: string; decks: string[] }
  | { type: 'gameStarted'; you: number[] }
  | { type: 'notice'; kind: string; text: string | null }
  | { type: 'pong' };

export type Action =
  | { action: 'ok' | 'cancel' | 'alphaStrike' | 'undo' | 'concede' }
  /** turn: the turn the client is showing, so a late click can't carry into the next turn */
  | { action: 'passUntilEndOfTurn'; turn?: number }
  | { action: 'card'; id: number; button?: number }
  | { action: 'player'; id: number; button?: number }
  | { action: 'stack'; id: number }
  | { action: 'mana'; color: number }
  | { action: 'reorderHand'; id: number; index: number };
