/*

index.js - "tart-checkpoint": Checkpointing configuration implementation

The MIT License (MIT)

Copyright (c) 2013 Dale Schumacher, Tristan Slominski

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

*/
"use strict";

var tart = require('tart');
var marshal = require('tart-marshal');

/*
    To dispatch:
        1. Checkpoint.
        2. If queue is empty, dispatch is done.
        3. Dequeue event to dispatch.
        4. Process event.
        5. Checkpoint.
        6. Schedule next dispatch.
        7. Dispatch is done.
    To checkpoint:
        1. If effect is empty, checkpoint is done.
        2. Write effect to log.
        3. If effect is an error, clear effect, checkpoint is done.
        4. Add messages sent, if any, to event queue.
        5. Concurrently:
            a. Persist actors created, if any.
            b. Persist updated event queue.
            c. Update state/behavior, if changed.
        6. Initialize empty effect.
        7. Checkpoint is done.
*/
module.exports.checkpoint = function checkpoint(options) {
    options = options || {};
    
    options.dispatchEvent = options.dispatchEvent || function dispatchEvent(callback) {
        // Checkpoint.
        options.saveCheckpoint(function (error) {
            if (error) { return callback(error); }
            // Dequeue event to dispatch.
            var event = options.dequeueEvent();
            // If queue is empty, dispatch is done.
            if (!event) { return callback(false); }
            // Process event.
            options.processEvent(event);
            // Checkpoint.
            options.saveCheckpoint(function (error) {
                if (error) { return callback(error); }
                // Schedule next dispatch.
                options.scheduleDispatch();
                // Dispatch is done.
                return callback(false);
            });
        });
    };

    options.saveCheckpoint = options.saveCheckpoint || function saveCheckpoint(callback) {
        // If effect is empty, checkpoint is done.
        if (options.effectIsEmpty(options.effect)) { return callback(false); }
        // Write effect to log.
        options.logEffect(function (error) {
            if (error) { return callback(error); }
            // If effect is an error, clear effect, checkpoint is done.
            if (options.effectIsError(options.effect)) {
                options.effect = options.newEffect();
                return callback(false);
            }
            // Add messages sent, if any, to event queue.
            options.enqueueEvents();
            // Persist global state
            options.persistState(function (error) {
                if (error) { return callback(error); }
                // Initialize empty effect.
                options.effect = options.newEffect();
                // Checkpoint is done.
                callback(false);
            });
        });
    };

    options.logEffect = options.logEffect || function logEffect(callback) {
        var json = domain.encode(options.effect);
        console.log('logEffect:', json);
        setImmediate(function () {
            callback(false);
        });
    };

    options.persistState = options.persistState || function persistState(callback) {
        console.log('persistState effect:', options.effect);
        console.log('persistState events:', options.events);
        setImmediate(function () {
            callback(false);
        });
    };

    options.newEffect = options.newEffect || function newEffect() {
        return {
            created: [],
            sent: []
        };
    };

    options.effectIsEmpty = options.effectIsEmpty || function effectIsEmpty(effect) {
        if (effect.event
        ||  effect.exception
        ||  (effect.sent.length > 0)
        ||  (effect.created.length > 0)) {
            return false;
        }
        return true;
    };

    options.effectIsError = options.effectIsError || function effectIsError(effect) {
        if (effect.exception) {
            return true;
        }
        return false;
    };

    options.enqueueEvents = options.enqueueEvents || function enqueueEvents() {
        options.events.push(options.effect.sent.slice());  // clone event batch
    };

    options.dequeueEvent = options.dequeueEvent || function dequeueEvent() {
        while (options.events.length > 0) {
            var batch = options.events[0];
            if (batch.length > 0) {
                return batch.shift();  // return next event
            }
            options.events.shift();
        }
        return false;
    };
    
    options.compileBehavior = options.compileBehavior || function compileBehavior(source) {
        return eval('(' + source + ')');  // must produce a Function
    };

    options.processEvent = options.processEvent || function processEvent(event) {
        console.log('processEvent event:', event);
        options.effect.event = event;
        try {
            options.effect.behavior = event.context.behavior;
            event.context.behavior = options.compileBehavior(options.effect.behavior);
            event.context.behavior(event.message);  // execute actor behavior
            options.effect.became = event.context.behavior.toString();
            event.context.behavior = options.effect.became;
        } catch (exception) {
            options.effect.exception = exception;
        }
        console.log('processEvent effect:', options.effect);
    }

    options.events = [];  // queue of pending events (in effect batches)
    
    options.effect = options.newEffect();  // initialize empty effect

    options.inDispatch = false;
    options.scheduleDispatch = options.scheduleDispatch || function scheduleDispatch() {
        setImmediate(function () {
            console.log('scheduleDispatch:', options.inDispatch);
            if (options.inDispatch) {
                options.errorHandler(new Error('DISPATCH RE-ENTRY'));
            }
            options.inDispatch = true;
            options.dispatchEvent(function (error) {
                options.inDispatch = false;
                options.errorHandler(error);
            });
        });
    };

    options.errorHandler = options.errorHandler || function errorHandler(error) {
        if (error) {
            console.log('FAIL!', error);
        }
    };

    options.scheduleDispatch();  // prime the pump...
    
    var name = options.name || 'checkpoint';
    var sponsor = options.sponsor || tart.minimal();
    var router = marshal.router(sponsor);
    var domain = router.domain(name);
    var receptionist = domain.receptionist;
    domain.receptionist = function checkpointReceptionist(message) {
        console.log('checkpointReceptionist:', message);
        receptionist(message);  // delegate to original receptionist
        options.scheduleDispatch();  // trigger checkpoint scheduler
    };
    var transport = domain.transport;
    domain.transport = function checkpointTransport(message) {
        console.log('checkpointTransport:', message);
        transport(message);  // delegate to original transport
    };

    options.checkpoint = {
        router: router,
        domain: domain,
        sponsor: function create(behavior, state) {
            state = state || {};
            var actor = function send(message) {
                var event = {
                    message: message,
                    context: context
                };
                options.effect.sent.push(event);
            };
            var context = {
                self: actor,
                state: state,
                behavior: behavior.toString(),
                sponsor: create
            };
            options.effect.created.push(context);
            return actor;
        }
    };

    return options.checkpoint;
};