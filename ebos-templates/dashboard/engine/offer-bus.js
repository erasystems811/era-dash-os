// One in-process EventEmitter fans a broadcast delivery_offer out to every
// rider currently holding the SSE connection open (routes/rider.js's
// GET /offers/stream). No queue/pubsub needed -- this deployment model is
// one container per business (see schema.sql's header comment), so there is
// only ever one process for every rider's connection to reach.
import { EventEmitter } from 'node:events';

export const offerBus = new EventEmitter();
// Default of 10 would log a misleading "possible memory leak" warning once
// more than 10 riders are on duty at once, which is a completely normal
// number of real listeners here, not a leak.
offerBus.setMaxListeners(0);
