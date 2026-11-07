declare module 'neo-blessed' {
  import blessed = require('blessed');
  export = blessed;
}

declare module 'neo-blessed/lib/unicode.js' {
  const unicode: {
    charWidth(value: string | number, index?: number): number;
    strWidth(value: string): number;
    chars: { all: RegExp };
  };
  export default unicode;
}
