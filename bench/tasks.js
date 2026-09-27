// Small, authored, offline general-task fixture set. Labels are exact and prompts are short so
// phone runs are bounded; this is a comparative smoke benchmark, not a published leaderboard.
const message = (instruction, text) => [
  { role: "system", content: instruction }, { role: "user", content: text },
];
const normalize = (text) => text.trim().toLowerCase().replace(/[.!,?]/g, "");
const exact = (expected) => (text) => normalize(text) === normalize(expected);
const json = (expected) => (text) => {
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return Object.entries(expected).every(([key, value]) => parsed[key] === value) && Object.keys(parsed).length === Object.keys(expected).length;
  } catch { return false; }
};

const classify = "Classify the message as exactly one label: food, travel, weather. Return the label only.";
const extract = "Extract a person's name and age from the note. Return only JSON with keys name (string) and age (number or null). Do not guess.";
const qa = "Answer using only the provided passage. If not stated, reply UNKNOWN. Answer briefly.";

export const TASKS = [
  { id: "classify-food", task: "classification", messages: message(classify, "The bread is fresh and the soup tastes great."), check: exact("food") },
  { id: "classify-travel", task: "classification", messages: message(classify, "The train leaves at six for Madrid."), check: exact("travel") },
  { id: "classify-weather", task: "classification", messages: message(classify, "Tomorrow will be rainy and windy."), check: exact("weather") },
  { id: "extract-age", task: "json_extraction", messages: message(extract, "Amina, age 34, visited the clinic."), check: json({ name: "Amina", age: 34 }) },
  { id: "extract-missing", task: "json_extraction", messages: message(extract, "Luis arrived this morning; no age was recorded."), check: json({ name: "Luis", age: null }) },
  { id: "extract-two-digit", task: "json_extraction", messages: message(extract, "A note from Mei states she is 27 years old."), check: json({ name: "Mei", age: 27 }) },
  { id: "qa-capital", task: "grounded_qa", messages: message(qa, "Passage: France's capital is Paris. Question: What is its capital?"), check: exact("Paris") },
  { id: "qa-year", task: "grounded_qa", messages: message(qa, "Passage: The clinic opened in 2018 and expanded in 2021. Question: When did it open?"), check: exact("2018") },
  { id: "qa-unknown", task: "grounded_qa", messages: message(qa, "Passage: The survey covered 12 villages. Question: What was its budget?"), check: exact("UNKNOWN") },
  { id: "instruction-ok", task: "instruction_following", messages: message("Follow formatting instructions exactly.", "Write exactly the word OK and nothing else."), check: (text) => text.trim() === "OK" },
  { id: "instruction-uppercase", task: "instruction_following", messages: message("Follow formatting instructions exactly.", "Reply with the uppercase word READY and nothing else."), check: (text) => text.trim() === "READY" },
  { id: "tool-date", task: "tool_call", messages: message("Use get_datetime to answer date questions. Do not guess dates.", "What is today's date? Call get_datetime first."), check: (text, calls) => calls.includes("get_datetime") && /2030-02-14/.test(text) },
];
