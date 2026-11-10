/** The PayPal JS SDK v6 button is a web component. */
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "paypal-button": DetailedHTMLProps<HTMLAttributes<HTMLElement> & { type?: string; hidden?: boolean }, HTMLElement>;
    }
  }
}
