/**
 * Pairs what the user said with the realtime answer it got, for the chat history. Transcripts of the
 * user's audio often arrive after the answer (or never, when the service doesn't transcribe), so each
 * committed turn waits for both sides — or a short grace period — and turns are saved in order.
 */

interface Exchange { id?: string; user: string; userDone: boolean; assistant: string; assistantDone: boolean; timer?: ReturnType<typeof setTimeout> }

export class VoiceExchanges {
  private list: Exchange[] = [];
  private saved = new Set<string>();

  constructor(private save: (user: string, assistant: string) => void, private transcriptWaitMs = 4000) {}

  private get last(): Exchange | undefined { return this.list[this.list.length - 1]; }

  /** The server committed a user turn: anything before it gets no more answer. */
  userTurn(id: string): void {
    if (this.saved.has(id) || this.list.some((item) => item.id === id)) return;
    // Transcript seen before the commit (id-less): adopt it.
    const last = this.last;
    if (last && !last.id && !last.assistant && !last.assistantDone) { last.id = id; return; }
    this.list.forEach((item) => this.endAnswer(item));
    this.list.push({ id, user: '', userDone: false, assistant: '', assistantDone: false });
    this.flush();
  }

  /** Returns true when the text belongs to the newest turn (worth showing on screen). */
  userText(text: string, meta: { itemId?: string; final?: boolean } = {}): boolean {
    const { itemId, final } = meta;
    if (itemId && this.saved.has(itemId)) return false;
    let exchange = itemId ? this.list.find((item) => item.id === itemId) : undefined;
    if (!exchange) {
      const last = this.last;
      if (last && !last.userDone && !last.assistantDone && (!itemId || !last.id)) exchange = last;
      else { exchange = { user: '', userDone: false, assistant: '', assistantDone: false }; this.list.push(exchange); }
      if (itemId) exchange.id = itemId;
    }
    exchange.user = text;
    if (final) this.userDone(exchange);
    const newest = exchange === this.last;
    this.flush();
    return newest;
  }

  assistantText(delta: string): void {
    let exchange = this.last;
    if (!exchange || exchange.assistantDone) { exchange = { user: '', userDone: false, assistant: '', assistantDone: false }; this.list.push(exchange); }
    exchange.assistant += delta;
  }

  responseDone(): void {
    const exchange = this.last;
    if (exchange && !exchange.assistantDone) this.endAnswer(exchange);
    this.flush();
  }

  /** The user talked over the answer: keep what was said, marked as cut off. */
  interrupted(): void {
    const exchange = this.last;
    if (exchange && exchange.assistant && !exchange.assistantDone) { exchange.assistant += '……'; this.endAnswer(exchange); }
    this.flush();
  }

  /** Session over: save whatever there is. */
  close(): void {
    this.list.forEach((item) => { if (item.timer) clearTimeout(item.timer); item.userDone = true; item.assistantDone = true; });
    this.flush();
  }

  private endAnswer(exchange: Exchange): void {
    if (exchange.assistantDone) return;
    exchange.assistantDone = true;
    if (exchange.userDone) return;
    // Services without turn ids (Gemini) send the transcript before the answer; others get a grace period.
    if (!exchange.id) { exchange.userDone = true; return; }
    exchange.timer = setTimeout(() => { exchange.timer = undefined; this.userDone(exchange); this.flush(); }, this.transcriptWaitMs);
  }

  private userDone(exchange: Exchange): void {
    exchange.userDone = true;
    if (exchange.timer) { clearTimeout(exchange.timer); exchange.timer = undefined; }
  }

  private flush(): void {
    while (this.list.length && this.list[0].userDone && this.list[0].assistantDone) {
      const exchange = this.list.shift()!;
      if (exchange.id) this.saved.add(exchange.id);
      const user = exchange.user.trim();
      const assistant = exchange.assistant.trim();
      if (user || assistant) this.save(user, assistant);
    }
  }
}
