import type { SigningStargateClient } from "@cosmjs/stargate";
import type { ToastOptions } from 'react-hot-toast/headless';
import type { DualityFrontEndMessage } from "./types";

// re-use channels by origin
// note: we should only have one origin, but this separates state cleaner
const originPorts: { [origin: string]: MessagePort } = {};
// count IDs globally because many clients may attach to the same origin
let messageIdCounter = 0;
export default class DexFrameClient {
  private messagePort: MessagePort = undefined as any as MessagePort;
  // re-use the same channel for multiple clients, we should only need one
  constructor(allowedOrigin: string) {
    if (!originPorts[allowedOrigin]) {
      const channel = new MessageChannel();
      // don't connect without a whitelisted origin string
      if (allowedOrigin) {
        // start the port on this side and give the other port to the top frame
        channel.port1.start();
        window.top?.postMessage(
          { type: "dex-frame-messaging:initialize" },
          allowedOrigin,
          [channel.port2],
        );
      }
      // listen for failure
      channel.port1.addEventListener("messageerror", (e) => {
        console.error("there was a message error", e);
      });
      // for some reason 'addEventListener' doesn't work unless this is set?
      originPorts[allowedOrigin] = channel.port1;
    }
    this.messagePort = originPorts[allowedOrigin];
  }
  // listen to messages from parent frame
  subscribeToMessage<T extends DualityFrontEndMessage>(
    messageDataType: T["type"],
    eventCallback: (event: MessageEvent<T>["data"]) => void,
  ): () => void {
    const handleEvent = (event: MessageEvent) => {
      if (event.data.type === messageDataType) {
        try {
          eventCallback(event.data);
        } catch (e) {
          console.error("error in frame message:", e, event);
        }
      }
    };
    // add listener and return cleanup function
    this.messagePort.addEventListener("message", handleEvent);
    return () => this.messagePort.removeEventListener("message", handleEvent);
  }
  // post requests to parent frame
  signAndBroadcast(
    ...args: Parameters<SigningStargateClient["signAndBroadcast"]>
  ): ReturnType<SigningStargateClient["signAndBroadcast"]> {
    return new Promise((resolve, reject) => {
      // start waiting for the response to the request
      const id = messageIdCounter++;
      const handleRequestResponse = (event: MessageEvent) => {
        if (event.data?.id === id) {
          const { response, error } = event.data;
          if (error) {
            reject(error);
          } else {
            resolve(response);
          }
          this.messagePort.removeEventListener(
            "message",
            handleRequestResponse,
          );
        }
      };
      this.messagePort.addEventListener("message", handleRequestResponse);

      // post request
      this.messagePort.postMessage({ id, type: "signAndBroadcast", args });
    });
  }
  // show notifications in top window
  showNotification(opts: ToastOptions & {
    style?: "loading" | "success" | "error" | "blank";
    heading: string;
    body?: string;
    link?: string;
    dismissable?: boolean;
  }) {
    this.messagePort.postMessage({ type: "showNotification", opts });
  }
  // update height to parent
  updateFrameHeight(height: number) {
    this.messagePort.postMessage({ type: "frameHeight", height });
  }
}
