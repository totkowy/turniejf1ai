export interface Env {
  AI: Ai;
}

const MODEL = "@cf/zai-org/glm-4.7-flash";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Turniej F1 2026 AI",
        model: MODEL,
        aiBinding: Boolean(env.AI),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/test") {
      try {
        const result = await env.AI.run(MODEL, {
          messages: [
            {
              role: "system",
              content:
                "Jesteś redaktorem polskiej ligi wyścigowej Turniej F1 2026. Odpowiadaj krótko i po polsku.",
            },
            {
              role: "user",
              content:
                "Napisz jedno krótkie zdanie potwierdzające, że system Turniej F1 AI działa.",
            },
          ],
        });

        return json({
          ok: true,
          model: MODEL,
          result,
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    }

    return json(
      {
        ok: false,
        error: "Nieznany endpoint.",
      },
      404
    );
  },
} satisfies ExportedHandler<Env>;
