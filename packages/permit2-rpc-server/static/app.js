(function () {
        var qs = new URLSearchParams(window.location.search);
        var chainIdRaw = qs.get("chainId") || qs.get("chain") || "1";
        var chainId = Number.parseInt(chainIdRaw, 10);
        if (!Number.isFinite(chainId) || chainId <= 0) chainId = 1;

        var intervalMsRaw = Number.parseInt(qs.get("interval") || "1000", 10);
        var intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw > 0 ? intervalMsRaw : 1000;

        var sampleRateRaw = Number.parseFloat(qs.get("sampleRate") || qs.get("sample-rate") || "0.02");
        var sampleRate = Number.isFinite(sampleRateRaw) && sampleRateRaw >= 0 ? Math.min(1, sampleRateRaw) : 0.02;

        var maxSamplesRaw = Number.parseInt(qs.get("maxSamples") || qs.get("max-samples") || "5", 10);
        var maxSamplesPerInterval = Number.isFinite(maxSamplesRaw) && maxSamplesRaw > 0 ? maxSamplesRaw : 5;

        var maxInflightRaw = Number.parseInt(qs.get("maxInflight") || qs.get("max-inflight") || "10", 10);
        var maxInflight = Number.isFinite(maxInflightRaw) && maxInflightRaw > 0 ? maxInflightRaw : 10;

        var withBody = (qs.get("withBody") || qs.get("with-body") || "").toLowerCase();
        var useBody = withBody === "1" || withBody === "true";

        var wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
        var wsUrl = wsProto + "//" + window.location.host + "/" + String(chainId);
        var httpUrl = window.location.origin + "/" + String(chainId);

        var elStream = document.getElementById("stream");
        var elStreamPlaceholder = document.getElementById("stream-placeholder");
        var logo = document.getElementById("logo");

        var maxStreamRowsRaw = Number.parseInt(qs.get("maxRows") || "240", 10);
        var maxStreamRows = Number.isFinite(maxStreamRowsRaw) && maxStreamRowsRaw > 0 ? maxStreamRowsRaw : 240;

        var minOpacityRaw = Number.parseFloat(qs.get("minOpacity") || "0.12");
        var minOpacity = Number.isFinite(minOpacityRaw) ? Math.min(1, Math.max(0, minOpacityRaw)) : 0.12;

        var showEmptyRaw = (qs.get("showEmpty") || "").toLowerCase();
        var showEmpty = showEmptyRaw === "1" || showEmptyRaw === "true";

        function pulseLogo() {
          if (!logo) return;
          logo.classList.remove("pulse");
          void logo.offsetWidth;
          logo.classList.add("pulse");
        }

        function sleep(ms) {
          return new Promise(function (resolve) {
            setTimeout(resolve, ms);
          });
        }

        function isHexString(value) {
          return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
        }

        function parseHexBigInt(value) {
          if (!isHexString(value)) return undefined;
          try {
            return BigInt(value);
          } catch {
            return undefined;
          }
        }

        function formatUnits(value, decimals) {
          var negative = value < 0n;
          var abs = negative ? -value : value;
          var base = 10n ** BigInt(decimals);
          var whole = abs / base;
          var fraction = abs % base;

          if (decimals === 0) return (negative ? "-" : "") + whole.toString();

          var fractionPadded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
          var fractionPart = fractionPadded.length ? "." + fractionPadded : "";
          return (negative ? "-" : "") + whole.toString() + fractionPart;
        }

        function summarizeTx(tx) {
          var valueWei = tx.value;
          var valueBig = parseHexBigInt(valueWei);
          var gasPriceWei = parseHexBigInt(tx.gasPrice);
          var maxFeeWei = parseHexBigInt(tx.maxFeePerGas);
          var priorityFeeWei = parseHexBigInt(tx.maxPriorityFeePerGas);

          var input = tx.input;
          var dataBytes = isHexString(input) ? Math.max(0, (input.length - 2) / 2) : undefined;

          return {
            hash: tx.hash,
            from: tx.from,
            to: tx.to == null ? null : tx.to,
            valueWei: valueWei,
            valueEth: valueBig !== undefined ? formatUnits(valueBig, 18) : undefined,
            type: tx.type,
            gasLimit: tx.gas,
            gasPriceGwei: gasPriceWei !== undefined ? formatUnits(gasPriceWei, 9) : undefined,
            maxFeeGwei: maxFeeWei !== undefined ? formatUnits(maxFeeWei, 9) : undefined,
            priorityFeeGwei: priorityFeeWei !== undefined ? formatUnits(priorityFeeWei, 9) : undefined,
            nonce: tx.nonce,
            dataBytes: dataBytes,
          };
        }

        function createAsyncPool(maxConcurrent) {
          var queue = [];
          var inflight = 0;
          var draining = false;

          var drain = function () {
            if (draining) return;
            draining = true;
            try {
              while (inflight < maxConcurrent && queue.length > 0) {
                var task = queue.shift();
                if (!task) break;
                inflight++;
                task()
                  .catch(function () {})
                  .finally(function () {
                    inflight--;
                    drain();
                  });
              }
            } finally {
              draining = false;
            }
          };

          return {
            enqueue: function (task) {
              queue.push(task);
              drain();
            },
            stats: function () {
              return { inflight: inflight, queued: queue.length };
            },
          };
        }

        function isJsonRpcSuccessResponse(value) {
          return (
            typeof value === "object" &&
            value !== null &&
            value.jsonrpc === "2.0" &&
            typeof value.id === "number" &&
            Object.prototype.hasOwnProperty.call(value, "result")
          );
        }

        function isJsonRpcErrorResponse(value) {
          return (
            typeof value === "object" &&
            value !== null &&
            value.jsonrpc === "2.0" &&
            typeof value.id === "number" &&
            Object.prototype.hasOwnProperty.call(value, "error")
          );
        }

        function isSubscriptionNotification(value) {
          return (
            typeof value === "object" &&
            value !== null &&
            value.jsonrpc === "2.0" &&
            value.method === "eth_subscription" &&
            value.params &&
            typeof value.params.subscription === "string" &&
            Object.prototype.hasOwnProperty.call(value.params, "result")
          );
        }

        function JsonRpcWsClient(socket) {
          this.socket = socket;
          this.nextId = 1;
          this.pending = new Map();
          this.subscriptions = new Map();
          var self = this;
          this.socket.onmessage = function (event) {
            self.onMessage(event);
          };
          this.socket.onclose = function () {
            self.onClose();
          };
        }

        JsonRpcWsClient.connect = function (url, opts) {
          var timeoutMs = (opts && opts.timeoutMs) || 15000;
          return new Promise(function (resolve, reject) {
            var socket = new WebSocket(url);
            var done = false;
            var timer = setTimeout(function () {
              if (done) return;
              done = true;
              try {
                socket.close();
              } catch {}
              reject(new Error("Failed to open WebSocket connection (timeout)."));
            }, timeoutMs);

            socket.onopen = function () {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve(new JsonRpcWsClient(socket));
            };
            socket.onerror = function () {
              if (done) return;
              done = true;
              clearTimeout(timer);
              try {
                socket.close();
              } catch {}
              reject(new Error("Failed to open WebSocket connection (error)."));
            };
          });
        };

        JsonRpcWsClient.prototype.close = function () {
          try {
            this.socket.close();
          } catch {}
        };

        JsonRpcWsClient.prototype.call = function (method, params, opts) {
          var timeoutMs = (opts && opts.timeoutMs) || 15000;
          var id = this.nextId++;
          var request = { jsonrpc: "2.0", id: id, method: method, params: params || [] };
          var payload = JSON.stringify(request);
          var self = this;

          var responsePromise = new Promise(function (resolve, reject) {
            var timeout = setTimeout(function () {
              self.pending.delete(id);
              reject(new Error("JSON-RPC request timed out: " + method));
            }, timeoutMs);
            self.pending.set(id, { resolve: resolve, reject: reject, timeout: timeout });
          });

          this.socket.send(payload);
          return responsePromise;
        };

        JsonRpcWsClient.prototype.subscribe = async function (params, onResult) {
          var subscriptionId = await this.call("eth_subscribe", params || []);
          if (typeof subscriptionId !== "string") {
            throw new Error("eth_subscribe returned a non-string subscription id.");
          }
          this.subscriptions.set(subscriptionId, onResult);
          return subscriptionId;
        };

        JsonRpcWsClient.prototype.onMessage = function (event) {
          var raw = typeof event.data === "string" ? event.data : undefined;
          if (!raw) return;

          var decoded;
          try {
            decoded = JSON.parse(raw);
          } catch {
            return;
          }

          if (isJsonRpcSuccessResponse(decoded)) {
            var pending = this.pending.get(decoded.id);
            if (!pending) return;
            clearTimeout(pending.timeout);
            this.pending.delete(decoded.id);
            pending.resolve(decoded.result);
            return;
          }

          if (isJsonRpcErrorResponse(decoded)) {
            var pendingErr = this.pending.get(decoded.id);
            if (!pendingErr) return;
            clearTimeout(pendingErr.timeout);
            this.pending.delete(decoded.id);
            pendingErr.reject(new Error("JSON-RPC error " + decoded.error.code + ": " + decoded.error.message));
            return;
          }

          if (isSubscriptionNotification(decoded)) {
            var handler = this.subscriptions.get(decoded.params.subscription);
            if (!handler) return;
            handler(decoded.params.result);
          }
        };

        JsonRpcWsClient.prototype.onClose = function () {
          for (var entry of this.pending.entries()) {
            var id = entry[0];
            var pending = entry[1];
            clearTimeout(pending.timeout);
            pending.reject(new Error("WebSocket closed."));
            this.pending.delete(id);
          }
        };

        function JsonRpcHttpClient(url) {
          this.url = url;
          this.nextId = 1;
        }

        JsonRpcHttpClient.prototype.call = async function (method, params, opts) {
          var timeoutMs = (opts && opts.timeoutMs) || 15000;
          var id = this.nextId++;
          var payload = JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params || [] });
          var controller = new AbortController();
          var timeout = setTimeout(function () {
            controller.abort();
          }, timeoutMs);

          var response;
          try {
            response = await fetch(this.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: payload,
              signal: controller.signal,
            });
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              throw new Error("HTTP JSON-RPC request timed out: " + method);
            }
            throw error;
          } finally {
            clearTimeout(timeout);
          }

          var text = await response.text();
          var decoded;
          try {
            decoded = JSON.parse(text);
          } catch {
            throw new Error("HTTP JSON-RPC returned non-JSON (status " + String(response.status) + ").");
          }

          if (isJsonRpcSuccessResponse(decoded)) {
            if (decoded.id !== id) throw new Error("Mismatched JSON-RPC id for " + method + ".");
            return decoded.result;
          }

          if (isJsonRpcErrorResponse(decoded)) {
            if (decoded.id !== id) throw new Error("Mismatched JSON-RPC id for " + method + ".");
            throw new Error("JSON-RPC error " + decoded.error.code + ": " + decoded.error.message);
          }

          throw new Error("Unexpected JSON-RPC response for " + method + ".");
        };

        function parseJsonRpcError(error) {
          var message = error instanceof Error ? error.message : String(error);
          var match = message.match(/^JSON-RPC error (-?\\d+): (.*)$/);
          if (!match) return undefined;
          var code = Number(match[1]);
          if (!Number.isFinite(code)) return undefined;
          return { code: code, message: match[2] };
        }

        function isMethodUnavailableError(error) {
          var parsed = parseJsonRpcError(error);
          if (parsed && parsed.code === -32601) return true;
          var message = (parsed ? parsed.message : error instanceof Error ? error.message : "").toLowerCase();
          return (
            message.indexOf("does not exist") !== -1 ||
            message.indexOf("not available") !== -1 ||
            message.indexOf("not allowed") !== -1 ||
            message.indexOf("not supported") !== -1
          );
        }

        function isFilterNotFoundError(error) {
          return error instanceof Error && /filter not found|invalid filter id/i.test(error.message);
        }

        function parsePendingBlock(value) {
          if (!value || typeof value !== "object") return { hashes: [] };
          var block = value;
          var number = typeof block.number === "string" ? block.number : undefined;
          var txs = block.transactions;
          if (!Array.isArray(txs)) return { number: number, hashes: [] };
          var hashes = [];
          for (var i = 0; i < txs.length; i++) {
            var item = txs[i];
            if (typeof item === "string" && isHexString(item)) {
              hashes.push(item);
              continue;
            }
            if (item && typeof item === "object") {
              var hash = item.hash;
              if (typeof hash === "string" && isHexString(hash)) hashes.push(hash);
            }
          }
          return { number: number, hashes: hashes };
        }

        async function uninstallFilter(client, filterId) {
          try {
            await client.call("eth_uninstallFilter", [filterId], { timeoutMs: 2000 });
          } catch {}
        }

        function HttpPendingTxPoller(client) {
          this.client = client;
          this.mode = "filter";
          this.filterId = undefined;
          this.prevPendingHashes = undefined;
          this.consecutiveFailures = 0;
          this.filterResets = 0;
        }

        HttpPendingTxPoller.prototype.dispose = async function () {
          if (this.mode !== "filter") return;
          if (!this.filterId) return;
          var filterId = this.filterId;
          this.filterId = undefined;
          await uninstallFilter(this.client, filterId);
        };

        HttpPendingTxPoller.prototype.poll = async function () {
          if (this.mode === "pending-block") {
            return { mode: this.mode, hashes: await this.pollPendingBlock() };
          }

          var ready = await this.ensureFilter();
          if (!ready || this.mode !== "filter") {
            return { mode: this.mode, hashes: await this.pollPendingBlock() };
          }

          return { mode: this.mode, hashes: await this.pollFilter() };
        };

        HttpPendingTxPoller.prototype.ensureFilter = async function () {
          if (this.filterId) return true;
          try {
            var filterId = await this.client.call("eth_newPendingTransactionFilter", []);
            if (!isHexString(filterId) || filterId === "0x") throw new Error("Invalid filter id.");
            this.filterId = filterId;
            this.consecutiveFailures = 0;
            return true;
          } catch (error) {
            if (isMethodUnavailableError(error)) {
              this.mode = "pending-block";
              return false;
            }
            this.mode = "pending-block";
            return false;
          }
        };

        HttpPendingTxPoller.prototype.pollFilter = async function () {
          var filterId = this.filterId;
          if (!filterId) return [];
          try {
            var changes = await this.client.call("eth_getFilterChanges", [filterId]);
            this.consecutiveFailures = 0;
            if (!Array.isArray(changes)) return [];
            var hashes = [];
            for (var i = 0; i < changes.length; i++) {
              var item = changes[i];
              if (typeof item === "string" && isHexString(item)) hashes.push(item);
            }
            return hashes;
          } catch (error) {
            if (isFilterNotFoundError(error)) {
              this.filterResets++;
              this.filterId = undefined;
              if (this.filterResets >= 3) {
                this.mode = "pending-block";
              }
              return [];
            }
            this.consecutiveFailures++;
            this.filterId = undefined;
            if (this.consecutiveFailures >= 2 || isMethodUnavailableError(error)) {
              this.mode = "pending-block";
            }
            return [];
          }
        };

        HttpPendingTxPoller.prototype.pollPendingBlock = async function () {
          try {
            var block = await this.client.call("eth_getBlockByNumber", ["pending", false]);
            var info = parsePendingBlock(block);
            var current = new Set(info.hashes);
            var prev = this.prevPendingHashes;
            var newHashes = prev
              ? info.hashes.filter(function (hash) {
                  return !prev.has(hash);
                })
              : info.hashes;
            this.prevPendingHashes = current;
            return newHashes;
          } catch {
            return [];
          }
        };

			        function updateStreamOpacities() {
				          if (!elStream) return;
				          var rows = elStream.children;
				          var count = rows.length;
				          if (count <= 0) return;

				          var opacities = [];

				          var maxNonLatestOpacity = 2 / 3;

				          if (minOpacity >= maxNonLatestOpacity) {
				            for (var i = 0; i < count; i++) {
				              var t = count === 1 ? 1 : i / (count - 1);
				              var opacity = minOpacity + (1 - minOpacity) * t;
				              rows[i].style.opacity = String(opacity);
				              opacities.push(opacity);
				            }
				            console.log(opacities);
				            return;
				          }

				          for (var i = 0; i < count; i++) {
				            if (i === count - 1) {
				              rows[i].style.opacity = "1";
				              opacities.push(1);
				              continue;
				            }
				            var t = count === 1 ? 1 : i / (count - 1);
				            var opacity = minOpacity + (maxNonLatestOpacity - minOpacity) * t;
				            rows[i].style.opacity = String(opacity);
				            opacities.push(opacity);
				          }
				          console.log(opacities);
				        }

		        function trimStream() {
		          if (!elStream) return;
		          var guard = 0;

		          while (elStream.children.length > maxStreamRows && elStream.firstElementChild) {
		            elStream.removeChild(elStream.firstElementChild);
		            if (++guard > 1000) break;
		          }
		        }

	        function appendStreamRow(text) {
	          if (!elStream) return;

	          if (elStreamPlaceholder) {
	            try {
	              elStreamPlaceholder.remove();
	            } catch {}
	            elStreamPlaceholder = null;
	          }

	          var existing = Array.from(elStream.children);
	          var firstTops = new Map();
	          for (var i = 0; i < existing.length; i++) {
	            firstTops.set(existing[i], existing[i].getBoundingClientRect().top);
	          }

	          var row = document.createElement("span");
	          row.className = "stream-row mono";
	          row.textContent = text;
	          row.style.opacity = "0";
	          row.style.transform = "translateY(12px)";
	          row.style.transition = "none";
	          elStream.appendChild(row);

	          trimStream();

	          var remaining = Array.from(elStream.children);
	          for (var i = 0; i < remaining.length; i++) {
	            var el = remaining[i];
	            if (el === row) continue;
	            var first = firstTops.get(el);
	            if (first === undefined) continue;
	            var last = el.getBoundingClientRect().top;
	            var delta = first - last;
	            if (!delta) continue;
	            el.style.transition = "none";
	            el.style.transform = "translateY(" + String(delta) + "px)";
	          }

	          void elStream.offsetHeight;

	          requestAnimationFrame(function () {
	            for (var i = 0; i < remaining.length; i++) {
	              var el = remaining[i];
	              if (el === row) continue;
	              el.style.transition = "";
	              el.style.transform = "";
	            }

	            row.style.transition = "";
	            row.style.transform = "";
	            updateStreamOpacities();
	          });
	        }

        function setJson(eventObj) {
          var samples = eventObj && eventObj.data ? eventObj.data.samples : undefined;
          if (Array.isArray(samples) && (showEmpty || samples.length > 0)) {
            appendStreamRow(JSON.stringify(samples));
          }
        }

        async function start() {
          var stopped = false;
          var wsClient = null;
          var httpClient = new JsonRpcHttpClient(httpUrl);
          var poller = null;

          var stop = function () {
            stopped = true;
            try {
              wsClient && wsClient.close();
            } catch {}
            if (poller) {
              poller.dispose().catch(function () {});
              poller = null;
            }
          };

	          globalThis.addEventListener("beforeunload", stop);

          try {
            wsClient = await JsonRpcWsClient.connect(wsUrl, { timeoutMs: 15000 });

            var pool = createAsyncPool(maxInflight);
            var windowPending = 0;
            var windowSampled = 0;
            var totalSeen = 0;
            var sampleNulls = 0;
            var sampleErrors = 0;
            var samples = [];

            var enqueueLookup = function (hash) {
              pool.enqueue(async function () {
                try {
                  var tx = await wsClient.call("eth_getTransactionByHash", [hash]);
                  if (tx && typeof tx === "object") {
                    samples.push(summarizeTx(tx));
                  } else {
                    sampleNulls++;
                  }
                } catch {
                  sampleErrors++;
                }
              });
            };

            var onPendingResult = function (result) {
              windowPending++;
              totalSeen++;
              if (windowSampled >= maxSamplesPerInterval) return;
              if (Math.random() > sampleRate) return;
              windowSampled++;

              if (typeof result === "string" && isHexString(result)) {
                enqueueLookup(result);
                return;
              }

              if (typeof result === "object" && result !== null) {
                samples.push(summarizeTx(result));
              }
            };

            var subscribeParams = useBody ? ["newPendingTransactions", true] : ["newPendingTransactions"];
            try {
              await wsClient.subscribe(subscribeParams, onPendingResult);
            } catch (error) {
              if (useBody) {
                await wsClient.subscribe(["newPendingTransactions"], onPendingResult);
              } else {
                throw error;
              }
            }

            while (!stopped) {
              await sleep(intervalMs);
              var perSecond = windowPending / (intervalMs / 1000);
              var poolStats = pool.stats();
              var eventObj = {
                type: "pending_sample",
                ts: new Date().toISOString(),
                data: {
                  intervalMs: intervalMs,
                  pendingCount: windowPending,
                  pendingPerSecond: perSecond,
                  totalSeen: totalSeen,
                  samples: samples.splice(0, samples.length),
                  sampleNulls: sampleNulls,
                  sampleErrors: sampleErrors,
                  lookups: poolStats,
                },
              };
              setJson(eventObj);
              pulseLogo();
              windowPending = 0;
              windowSampled = 0;
              sampleNulls = 0;
              sampleErrors = 0;
            }

            return;
          } catch (error) {
            if (stopped) return;
            console.warn("ws unavailable; falling back to http", error);
          }

          poller = new HttpPendingTxPoller(httpClient);
          var poolHttp = createAsyncPool(maxInflight);
          var totalSeenHttp = 0;
          var sampleNullsHttp = 0;
          var sampleErrorsHttp = 0;
          var samplesHttp = [];

          var enqueueLookupHttp = function (hash) {
            poolHttp.enqueue(async function () {
              try {
                var tx = await httpClient.call("eth_getTransactionByHash", [hash]);
                if (tx && typeof tx === "object") {
                  samplesHttp.push(summarizeTx(tx));
                } else {
                  sampleNullsHttp++;
                }
              } catch {
                sampleErrorsHttp++;
              }
            });
          };

          while (!stopped) {
            await sleep(intervalMs);
            var polled = await poller.poll();
            var hashes = polled.hashes;
            var windowCount = hashes.length;
            totalSeenHttp += windowCount;

            var windowSampledHttp = 0;
            for (var i = 0; i < hashes.length; i++) {
              if (windowSampledHttp >= maxSamplesPerInterval) break;
              if (Math.random() > sampleRate) continue;
              windowSampledHttp++;
              enqueueLookupHttp(hashes[i]);
            }

            var perSecondHttp = windowCount / (intervalMs / 1000);
            var poolStatsHttp = poolHttp.stats();
            var eventObjHttp = {
              type: "pending_sample",
              ts: new Date().toISOString(),
              data: {
                intervalMs: intervalMs,
                pendingCount: windowCount,
                pendingPerSecond: perSecondHttp,
                totalSeen: totalSeenHttp,
                samples: samplesHttp.splice(0, samplesHttp.length),
                sampleNulls: sampleNullsHttp,
                sampleErrors: sampleErrorsHttp,
                lookups: poolStatsHttp,
                pollMode: polled.mode,
              },
            };
            setJson(eventObjHttp);
            pulseLogo();
            sampleNullsHttp = 0;
            sampleErrorsHttp = 0;
          }
        }

        globalThis.addEventListener("resize", function () {
          trimStream();
          updateStreamOpacities();
        });

        var auto = (qs.get("autostart") || "1").toLowerCase();
        if (auto === "1" || auto === "true") {
          start().catch(function (error) {
            console.warn("mempool preview failed", error);
          });
        }
      })();
