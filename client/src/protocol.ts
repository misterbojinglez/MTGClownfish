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
  /** an effect Forge makes for the game (speed's "Start Your Engines!"), not a printed card */
  effect?: boolean;
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
  /** spells and abilities of opponents that target it are countered unless they pay */
  ward?: boolean;
  /** keywords worth showing on the battlefield (Haste, Vigilance, Trample…) */
  keywords?: string[];
  /** prepared (Strixhaven): the name of the spell copy waiting to be cast; clicking the card casts it */
  preparedSpell?: string | null;
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
  /** speed (Start your engines!), 1 to 4, once they have any */
  speed?: number;
  counters: Record<string, number>;
  mana: Record<string, number>;
  zones: {
    Battlefield: number[];
    Graveyard: number[];
    Exile: number[];
    Command: number[];
    Hand: number[];
    LibraryCount: number;
    /** the top card of the library, when this player may see it (Bolas's Citadel, Future Sight) */
    LibraryTop?: number;
    /** that top card can be played right now */
    LibraryTopPlayable?: boolean;
  };
  commanderDamage?: Record<string, number>;
  commanders?: number[];
  /** exiled cards (in anyone's exile) this player has been allowed to play: impulse draw, Tinybones' stash, adventures */
  exilePlayable?: number[];
  /** commanders' combined colour identity in WUBRG order ("" colourless); absent outside Commander */
  identity?: string;
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
  /** Pass Turn is in effect */
  passing?: boolean;
  /** targets: at most one from each player's cards; or all from one player's */
  onePer?: 'player';
  samePlayer?: boolean;
  /** what's being aimed is bad for the player it's aimed at */
  harmful?: boolean;
  /** declaring attackers: creatures that must attack (`at`: whom, when only some defenders will do) */
  mustAttack?: { card: number; at?: string }[];
  message: string;
  card?: number | null;
  ok?: Button;
  cancel?: Button;
  /** Forge input class behind this prompt, e.g. InputPassPriority, InputPayManaOfCostPayment */
  input?: string | null;
  /** which Forge input object this is: a new number for each prompt (the same one while you pick several cards) */
  inputId?: number;
  source?: ResolvingSource | null;
  /** while paying a cost: the symbols life can pay instead of mana (Phyrexian mana, {B} under K'rrik) */
  lifePay?: LifePay;
}

export interface LifePay {
  /** how many such symbols are still unpaid */
  shards: number;
  /** life per symbol (2) */
  each: number;
  /** life already set aside for symbols paid this way; Forge takes it when the payment completes */
  committed: number;
  life: number;
  /** nothing but life-payable symbols left to pay */
  onlyLife: boolean;
  /** the paying player (a click on them pays one symbol with life) */
  player: number;
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
  /** distribute (combat): damage that kills this blocker */
  lethal?: number;
  /** distribute (combat): the share it starts with (the automatic split) */
  initial?: number;
  /** distribute (combat): the defending player or planeswalker, reached by trample */
  defender?: boolean;
  ability?: number;
  player?: number;
  entity?: number;
}

export interface RequestMsg {
  type: 'request';
  id: number;
  kind: 'choose' | 'reveal' | 'order' | 'confirm' | 'input' | 'distribute' | 'piles' | 'place' | 'modes' | 'number';
  /** place: the named places cards go to, and the one they start in; answered { places: option indices per place
   * (in draw order where ordered), skip }. allowed: the options that may go there (all of them without it) */
  places?: { label: string; kind: string; min: number; max: number; ordered: boolean; allowed?: number[] }[];
  start?: number;
  /** place, for scry and surveil: what it's called, and how many more like it wait on the stack */
  verb?: string | null;
  remaining?: number;
  /** choose: options shown but not to be picked; distinct: no two with the same name */
  disabled?: number[];
  /** choose: at most one from each player's cards */
  onePer?: 'player';
  distinct?: boolean;
  /** order: the answer may be remembered, as { order, remember } */
  canRemember?: boolean;
  /** modes: the same one may be chosen more than once */
  repeat?: boolean;
  /** number: backing out (null) is allowed */
  cancel?: boolean;
  /** the card it's about, when it may not be on the table */
  cardData?: CardState;
  /** distribute, combat: any damage at all kills a creature */
  deathtouch?: boolean;
  /** piles: the two piles to choose between (a face-down pile sends only its count); answered 0 or 1 */
  piles?: { label: string; count: number; hidden: boolean; options: ChoiceOption[] }[];
  /** distribute: total to divide, and whether every option needs at least one */
  amount?: number;
  atLeastOne?: boolean;
  /** distribute: dividing a creature's combat damage among its blockers (and, trampling, the defender) */
  combat?: boolean;
  /** combat: the defender may take damage before every blocker has lethal (assigns as though unblocked) */
  freeDefender?: boolean;
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
/** gameplan: the player's plain-language plan for an AI opponent's deck, turned into AI settings by the bridge */
export type SeatDeckSpec = ({ list: string; name?: string; commanders?: string[] } | { precon: string }) & { gameplan?: string };

/** how the bridge's AI will read a gameplan: the plan Claude made from it (or why it couldn't) */
export interface GameplanInfo {
  type: 'gameplan';
  id: number;
  ok: boolean;
  summary?: string;
  stance?: 'aggressive' | 'balanced' | 'defensive';
  tokensAreFodder?: boolean;
  cards?: {
    name: string;
    castPriority: number;
    value: number;
    sacrificeFodder: number;
    discardFodder: number;
    castBeforeCombat: boolean;
    protect: boolean;
    engine: boolean;
  }[];
  error?: string;
  /** there's no usable Claude API key: ask for one */
  noKey?: boolean;
}

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
  | GameplanInfo
  | LobbyState
  | { type: 'lobbyClosed'; reason: string }
  | { type: 'welcome'; returning: boolean; remote: boolean; relay?: string | null }
  | { type: 'precons'; format: string; decks: PreconInfo[] }
  | VoteMsg
  /** a one-time stop was used: key as in PlayOptions.stops */
  | { type: 'stopUsed'; key: string }
  /** Tabletalk: it's on (with what's been said so far), somebody spoke, the deals in force changed */
  | { type: 'talkState'; on: boolean; lines: TalkLine[]; deals: TalkDeal[] }
  | TalkLine
  | { type: 'deals'; deals: TalkDeal[] }
  | { type: 'offer'; id: number; state: OfferState };

/** Something said at the table (or, system, a word from the table itself: a deal struck or broken). */
export interface TalkLine {
  type: 'talk';
  id: number;
  player?: number | null;
  name?: string;
  text: string;
  human?: boolean;
  system?: boolean;
  /** an answer to somebody (or their own words): shown at once, not after the table's animations */
  reply?: boolean;
  /** a deal offered to a player, and how it was answered */
  offer?: { to: number; state: OfferState };
}

export type OfferState = 'open' | 'accepted' | 'declined' | 'lapsed';

/** A deal in force, and how many more turns it has. */
export interface TalkDeal {
  id: number;
  summary: string;
  left: number;
}

/** A vote among the people at the table (restarting the match): sent as it opens, as people answer, and with its result. */
export interface VoteMsg {
  type: 'vote';
  id: number;
  kind: 'restart';
  /** who called it */
  by: string;
  voters: string[];
  agreed: string[];
  /** whether you have agreed */
  voted: boolean;
  /** how long the vote stays open */
  seconds: number;
  result?: 'passed' | 'failed' | 'expired';
  reason?: string;
}

export type Action =
  /** auto: the client's own auto-pay (the bridge won't let it sacrifice a mana source) */
  | { action: 'ok'; auto?: boolean }
  | { action: 'cancel' | 'alphaStrike' | 'undo' | 'concede' }
  /** turn: the turn the client is showing, so a late click can't carry into the next turn */
  /** take Pass Turn back; ask again about orders that were to be remembered */
  | { action: 'resumeTurn' | 'forgetOrders' }
  | { action: 'passUntilEndOfTurn'; turn?: number; stack?: number[] }
  | { action: 'card'; id: number; button?: number }
  | { action: 'player'; id: number; button?: number }
  | { action: 'stack'; id: number }
  | { action: 'mana'; color: number }
  | { action: 'floating' }
  | { action: 'reorderHand'; id: number; index: number };

/** what a lobby seat's deck looks like on the seat list */
export interface LobbyDeckInfo {
  label?: string;
  commanders?: string[];
  colors?: string[];
  face?: { name: string; set: string; cn: string };
}

export interface LobbySeat {
  kind: 'host' | 'human' | 'ai' | 'open';
  name: string;
  connected: boolean;
  ready: boolean;
  deck: LobbyDeckInfo | null;
  /** host only, for AI and open seats: the deck spec and gameplan picked for it */
  spec?: SeatDeckSpec | null;
  gameplan?: string | null;
}

/** an online lobby, from this player's point of view */
export interface LobbyState {
  type: 'lobby';
  /** the join code, once the relay has opened the lobby */
  code: string | null;
  /** the page friends open to join */
  link: string | null;
  format: 'constructed' | 'commander';
  playing: boolean;
  /** whether you're the host */
  host: boolean;
  /** your seat index */
  you: number;
  /** the AIs talk during the game */
  talk: boolean;
  /** the relay couldn't be reached, etc. */
  problem: string | null;
  seats: LobbySeat[];
}
