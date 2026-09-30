type Handler<T> = (payload: T) => void;

export class EventBus<TEvents extends { [TKey in keyof TEvents]: unknown }> {
  private readonly listeners = new Map<keyof TEvents, Set<Handler<TEvents[keyof TEvents]>>>();

  on<TKey extends keyof TEvents>(event: TKey, handler: Handler<TEvents[TKey]>): () => void {
    const handlers = this.listeners.get(event) ?? new Set<Handler<TEvents[keyof TEvents]>>();
    handlers.add(handler as Handler<TEvents[keyof TEvents]>);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler as Handler<TEvents[keyof TEvents]>);
  }

  emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
    this.listeners.get(event)?.forEach((handler) => handler(payload));
  }

  clear(): void {
    this.listeners.clear();
  }
}
