import Screen from "blessed/lib/widgets/screen.js";
import Box from "blessed/lib/widgets/box.js";
import List from "blessed/lib/widgets/list.js";
import Prompt from "blessed/lib/widgets/prompt.js";
import Question from "blessed/lib/widgets/question.js";

// Avoid importing "blessed" directly: it dynamically requires *all* widgets, which
// breaks Bun's standalone `--compile` bundling. We only load what we use.
export const blessed = {
  screen: Screen as unknown as typeof Screen,
  box: Box as unknown as typeof Box,
  list: List as unknown as typeof List,
  prompt: Prompt as unknown as typeof Prompt,
  question: Question as unknown as typeof Question,
};

