import { NextRequest, NextResponse } from "next/server";

interface TriviaQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
}

const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-70b-versatile",
  "mixtral-8x7b-32768",
  "llama-3.1-8b-instant",
  "gemma2-9b-it",
];

const CATEGORIES = [
  "general",
  "science",
  "history",
  "geography",
  "entertainment",
  "sports",
  "technology",
  "art",
  "literature",
  "music",
];

async function generateWithGroq(
  prompt: string,
  model: string,
  apiKey: string
): Promise<string> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: `You are a trivia question generator. Generate engaging, factual trivia questions with exactly 4 answer options. Always respond with valid JSON only, no markdown or extra text.`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.8,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Groq API error (${model}): ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function generateTriviaWithFallback(
  category: string,
  count: number,
  apiKey: string
): Promise<TriviaQuestion[]> {
  const prompt = `Generate ${count} unique trivia questions about ${category}. 
Each question should have exactly 4 options with only one correct answer.
Make questions varied in difficulty (mix of easy, medium, and hard).

Return ONLY a JSON array with this exact structure (no markdown, no explanation):
[
  {
    "question": "What is...?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0
  }
]

The correctAnswer is the index (0-3) of the correct option.
Ensure questions are factually accurate and engaging.`;

  let lastError: Error | null = null;

  for (const model of GROQ_MODELS) {
    try {
      const response = await generateWithGroq(prompt, model, apiKey);
      
      // Parse and validate the response
      const cleanedResponse = response
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      
      const questions = JSON.parse(cleanedResponse) as TriviaQuestion[];
      
      // Validate structure
      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error("Invalid response structure");
      }
      
      for (const q of questions) {
        if (
          typeof q.question !== "string" ||
          !Array.isArray(q.options) ||
          q.options.length !== 4 ||
          typeof q.correctAnswer !== "number" ||
          q.correctAnswer < 0 ||
          q.correctAnswer > 3
        ) {
          throw new Error("Invalid question structure");
        }
      }
      
      return questions.slice(0, count);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`Model ${model} failed, trying next...`, lastError.message);
      continue;
    }
  }

  throw lastError || new Error("All models failed to generate trivia");
}

export async function POST(request: NextRequest) {
  try {
    const { category = "general", count = 10 } = await request.json();

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Groq API key not configured" },
        { status: 500 }
      );
    }

    // Validate category
    const normalizedCategory = category.toLowerCase();
    const validCategory = CATEGORIES.includes(normalizedCategory)
      ? normalizedCategory
      : "general";

    const questions = await generateTriviaWithFallback(
      validCategory,
      Math.min(count, 20),
      apiKey
    );

    return NextResponse.json({ questions });
  } catch (error) {
    console.error("Trivia generation error:", error);
    return NextResponse.json(
      { error: "Failed to generate trivia questions" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ categories: CATEGORIES });
}
