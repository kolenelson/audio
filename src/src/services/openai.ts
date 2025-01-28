export const createRealtimeSession = async () => {
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "alloy",
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create realtime session: ${await response.text()}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error creating realtime session:', error);
    throw error;
  }
};
