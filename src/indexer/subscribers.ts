type FlattenSingularItems<T> = T extends [infer U] ? U : T;

type value = string | number;
export type BaseDataRow = FlattenSingularItems<[id: value, values: value | value[]]>;
export type BaseDataSet<DataRow extends BaseDataRow> = Map<DataRow['0'], DataRow['1']>;

type IndexerPage<DataRow = BaseDataRow> = {
  shape:
    | [[string, string | string[]]]
    | [[[string, string | string[]]], [[string, string | string[]]]];
  data: Array<DataRow>;
  pagination?: {
    next_key?: string | null;
  };
  block_range?: {
    from_height: number;
    to_height: number;
  };
};

interface StreamCallbacks<DataRow = BaseDataRow> {
  // onUpdate returns individual update chunks
  onUpdate?: (dataUpdates: DataRow[], height: number) => void;
  // onCompleted indicates when the data stream is finished
  onCompleted?: () => void;
  // allow errors to be seen and handled
  onError?: (error: Error) => void;
}
export interface StreamOptions {
  // optional single AbortController for all the requests
  abortController?: AbortController;
  // allow SSE requests to be disabled (they are slower to start)
  disableSSE?: boolean;
  // allow custom request backoff resolution in milliseconds
  backoffFunc?: (retries: number) => number
}
export interface AccumulatorOptions {
  // optional value to remove from accumulator maps
  // (0 values should be removed from liquidity maps)
  mapEntryRemovalValue?: 0;
}
export class IndexerStream<DataRow = BaseDataRow> {
  // use single AbortController for all the requests
  private abortController = new AbortController();
  // define default request backoff function, linearly increasing by 1s per try
  private backoffFunc = (retries: number) => retries * 1000;

  constructor(
    endpoint: URL | string,
    callbacks: StreamCallbacks<DataRow>,
    opts?: StreamOptions
  ) {
    // replace abortController if one is given
    this.abortController = opts?.abortController ?? this.abortController;
    if (opts?.backoffFunc) {
      this.backoffFunc = opts?.backoffFunc;
    }
    const url = new URL(endpoint);
    // attempt to subscribe to Server-Sent Events
    new Promise<void>((resolve, reject) => {
      if (!opts?.disableSSE) {
        resolve();
      } else {
        reject('skip SSE and go to fallback methods');
      }
    })
      // primarily attempt to use a SSE connection
      .then(() => this.subscribeToSSE(url, callbacks))
      // fallback to long-polling if not available
      .catch(() => this.subscribeToLongPolling(url, callbacks))
      .catch((e) => {
        // unsubscribe on failure of all methods
        this.unsubscribe();
        // eslint-disable-next-line no-console
        console.error(
          `Could not establish a connection to the indexer URL: ${url}`
        );
        // send error to be handled
        callbacks.onError?.(e instanceof Error ? e : new Error(`${e}`));
      });
  }

  private async subscribeToSSE(url: URL, callbacks: StreamCallbacks<DataRow>) {
    return await new Promise<void>((resolve, reject) => {
      // create cancellable SSE event source
      const listenerOptions = { signal: this.abortController.signal };
      try {
        // add event source and add a cancellation listener
        const eventSource = new EventSource(url);
        this.abortController.signal.onabort = () => eventSource.close();
        // listen for updates and remove listener if aborted
        eventSource.addEventListener(
          'update',
          (e: MessageEvent<string>) => {
            let dataUpdates: DataRow[] | undefined;
            if (e.data) {
              try {
                dataUpdates = JSON.parse(e.data) as DataRow[];
              } catch (err) {
                reject(
                  new Error(`Could not parse data: ${e.data}`, {
                    cause: err instanceof Error ? err : new Error(`${err}`),
                  })
                );
              }
            }
            if (dataUpdates) {
              const heightOfData = Number(e.lastEventId.split(':').at(0));
              // send update directly to listener
              callbacks.onUpdate?.(dataUpdates, heightOfData);
            }
          },
          listenerOptions
        );
        // 'end' message is sent if a data stream is complete
        eventSource.addEventListener(
          'end',
          () => {
            // send onCompleted event to listener
            callbacks.onCompleted?.();
            // end promise
            resolve();
          },
          listenerOptions
        );
        eventSource.addEventListener(
          'error',
          (e) => {
            callbacks.onError?.(
              new Error('SSE error', { cause: new Error(e.type) })
            );
            // cancel the SSE if it is already closed
            if (eventSource.CLOSED) {
              reject(new Error('Could not establish an open EventSource'));
            }
          },
          listenerOptions
        );
      } catch (e) {
        reject(
          new Error('SSE Error', {
            cause: e instanceof Error ? e : new Error(`${e}`),
          })
        );
      }
    });
  }

  maxRetries = 5;
  private async subscribeToLongPolling(
    url: URL,
    callbacks: StreamCallbacks<DataRow>
  ) {
    return await new Promise<void>(async (resolve, reject) => {
      // create cancellable long-polling fetch options
      const fetchOptions = { signal: this.abortController.signal };
      try {
        let knownHeight = 0;
        // hack/fix: to control time limit behavior, assume the before timestamp
        //           is in the past as we can't candle future timestamp limits
        const toHeight = url.searchParams.get('pagination.before')
          ? 0
          : Number(url.searchParams.get('block_range.to_height')) ||
            Number.POSITIVE_INFINITY;
        do {
          let retries = 0;
          let nextKey: string | undefined = undefined;
          do {
            // overwrite block height to request from (to long-poll next update)
            // note: known height is usually the chain height so the request
            //       will be answered when the next block of data is available)
            if (knownHeight) {
              url.searchParams.set(
                'block_range.from_height',
                knownHeight.toFixed()
              );
            }
            // add next page key if not all data was returned by last request
            if (nextKey) {
              url.searchParams.set('pagination.key', nextKey);
            }
            const response = await fetch(url.toString(), fetchOptions);
            if (response.status === 200) {
              const {
                data = [],
                pagination = {},
                block_range: range,
              } = (await response.json()) as IndexerPage<DataRow>;
              // send update directly to listener
              callbacks.onUpdate?.(data, Number(range?.to_height));
              // set known height for next request
              if (range && range.to_height > knownHeight) {
                knownHeight = range.to_height;
              }
              // fetch again if necessary
              nextKey = pagination['next_key'] || undefined;
            }
            // if the request was not successful, log it and try to continue
            // (with a brief pause to not cause a large cascade of errors)
            else {
              // retry only if reasonable
              if (retries < this.maxRetries) {
                // eslint-disable-next-line no-console
                console.error(
                  `Could not fetch long-polling data (attempt: ${
                    retries + 1
                  }, code: ${
                    response.status
                  }), response: ${await response.text()}`
                );
                // relate back-off to number of retries for a linear back-off
                const backoffMs = this.backoffFunc(retries);
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                retries += 1;
                continue;
              }
              // exit loop due to stuck request
              else {
                throw new Error(
                  `Could not fetch data after ${this.maxRetries} times.`
                );
              }
            }
          } while (nextKey);
        } while (knownHeight < toHeight);

        // if there is no new height to consider the request is completed
        // send onCompleted event to listener
        callbacks.onCompleted?.();
        // end promise
        resolve();
      } catch (e) {
        reject(
          new Error('Long-Polling Error', {
            cause: e instanceof Error ? e : new Error(`${e}`),
          })
        );
      }
    });
  }

  // call to unsubscribe from any data stream
  unsubscribe() {
    // abort any current requests
    this.abortController.abort();
  }
}

// abstraction of accumulatation update function that can be replaced if needed
export function accumulateUpdates<
  DataRow extends BaseDataRow,
  DataSet extends BaseDataSet<DataRow> = BaseDataSet<DataRow>
>(currentMap: DataSet, dataUpdates: DataRow[], opts: AccumulatorOptions) {
  // create new map or use current map
  const newMap = new Map(currentMap) as DataSet;
  // add data updates to new map
  return accumulateUpdatesUsingMutation(newMap, dataUpdates, opts);
}

// accumulation function that may be quicker than using non-mutation (for React)
export function accumulateUpdatesUsingMutation<
  DataRow extends BaseDataRow,
  DataSet extends BaseDataSet<DataRow> = BaseDataSet<DataRow>
>(map: DataSet, dataUpdates: DataRow[], opts: AccumulatorOptions) {
  // add data updates to current map
  // note: if you received an error about here you might be using the incorrect
  //       indexer class (single/dual datasets) required for the endpoint
  for (const [id, data] of dataUpdates) {
    // remove keys if the data is defined as "empty"
    if (opts.mapEntryRemovalValue === data) {
      map.delete(id);
    } else {
      map.set(id, data);
    }
  }
  return map;
}

interface StreamSingleDataSetCallbacks<
  DataRow extends BaseDataRow,
  DataSet extends BaseDataSet<DataRow> = BaseDataSet<DataRow>
> extends Omit<StreamCallbacks<DataRow>, 'onCompleted'> {
  // onCompleted indicates when the data stream is finished
  onCompleted?: (dataSet: DataSet, height: number) => void;
  // onAccumulated returns accumulated DataSet so far as a Map
  onAccumulated?: (dataSet: DataSet, height: number) => void;
}
export class IndexerStreamAccumulateSingleDataSet<
  DataRow extends BaseDataRow,
  DataSet extends BaseDataSet<DataRow> = BaseDataSet<DataRow>
> {
  private dataSet: DataSet = new Map() as DataSet;
  private dataHeight = 0;
  private stream?: IndexerStream<DataRow>;

  constructor(
    endpoint: URL | string,
    callbacks: StreamSingleDataSetCallbacks<DataRow>,
    opts?: AccumulatorOptions & StreamOptions
  ) {
    this.stream = new IndexerStream<DataRow>(
      endpoint,
      {
        onUpdate: (dataUpdates: DataRow[], dataHeight: number) => {
          callbacks.onUpdate?.(dataUpdates, dataHeight);
          // update accumulated dataSet
          this.dataHeight = dataHeight;
          this.dataSet = this.accumulateDataSet(dataUpdates, {
            mapEntryRemovalValue: opts?.mapEntryRemovalValue,
          });
          // send updated dataSet to listener
          callbacks.onAccumulated?.(this.dataSet, this.dataHeight);
        },
        onError: callbacks.onError,
        onCompleted: () =>
          callbacks.onCompleted?.(this.dataSet, this.dataHeight),
      },
      {
        abortController: opts?.abortController,
        disableSSE: opts?.disableSSE,
      }
    );
  }

  // abstracted method to update saved dataSet
  private accumulateDataSet = (
    dataUpdates: DataRow[],
    opts: AccumulatorOptions = {}
  ) => {
    return this.accumulateUpdates(this.dataSet, dataUpdates, opts);
  };

  // add default accumulation function, but allow it to be replaced if needed
  public accumulateUpdates = accumulateUpdates;

  // call to unsubscribe from any data stream
  unsubscribe() {
    // abort any current requests
    this.stream?.unsubscribe();
  }
}

interface StreamDualDataSetCallbacks<
  DataRow extends BaseDataRow,
  DataSet extends BaseDataSet<DataRow> = BaseDataSet<DataRow>
> extends Omit<StreamCallbacks<DataRow>, 'onUpdate' | 'onCompleted'> {
  // onUpdate returns individual update chunks
  onUpdate?: (update: DataRow[][], height: number) => void;
  // onCompleted indicates when the data stream is finished
  onCompleted?: (dataSet: DataSet[], height: number) => void;
  // onAccumulated returns accumulated DataSet so far as a Map
  onAccumulated?: (dataSet: DataSet[], height: number) => void;
}
export class IndexerStreamAccumulateDualDataSet<
  DataRow extends BaseDataRow,
  DataSet extends BaseDataSet<DataRow> = BaseDataSet<DataRow>
> {
  // store data in class instance
  private dataSets: DataSet[] = [new Map(), new Map()] as DataSet[];
  private dataHeight = 0;
  private stream?: IndexerStream<DataRow[]>;

  constructor(
    endpoint: URL | string,
    callbacks: StreamDualDataSetCallbacks<DataRow>,
    opts?: AccumulatorOptions & StreamOptions
  ) {
    this.stream = new IndexerStream<DataRow[]>(
      endpoint,
      {
        onUpdate: (dataUpdates: DataRow[][], dataHeight: number) => {
          callbacks.onUpdate?.(dataUpdates, dataHeight);
          // update accumulated dataSet
          this.dataHeight = dataHeight;
          this.dataSets = this.accumulateDataSet(dataUpdates, {
            mapEntryRemovalValue: opts?.mapEntryRemovalValue,
          });
          // send updated dataSet to listener
          callbacks.onAccumulated?.(this.dataSets, this.dataHeight);
        },
        onError: callbacks.onError,
        onCompleted: () =>
          callbacks.onCompleted?.(this.dataSets, this.dataHeight),
      },
      {
        abortController: opts?.abortController,
        disableSSE: opts?.disableSSE,
      }
    );
  }

  // abstracted method to update saved dataSet
  private accumulateDataSet = (
    dataUpdates: DataRow[][],
    opts: AccumulatorOptions = {}
  ) => {
    // create new objects (to escape React referential-equality comparision)
    this.dataSets = [
      this.accumulateUpdates(this.dataSets[0], dataUpdates[0], opts),
      this.accumulateUpdates(this.dataSets[1], dataUpdates[1], opts),
    ];
    return this.dataSets;
  };

  // add default accumulation function, but allow it to be replaced if needed
  public accumulateUpdates = accumulateUpdates;

  // call to unsubscribe from any data stream
  unsubscribe() {
    // abort any current requests
    this.stream?.unsubscribe();
  }
}
