import { Schema } from "prosemirror-model";
export const documentSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", attrs: { id: { default: null } } },
    text: {},
  },
});
