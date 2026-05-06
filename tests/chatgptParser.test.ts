import JSZip from "jszip";
import {
  ChatGptParseError,
  parseChatGptConversationsJson,
  parseChatGptExportZip
} from "../src/chatgptParser";

describe("ChatGPT export parser", () => {
  it("flattens timestamped mapping messages and skips empty turns", () => {
    const conversations = parseChatGptConversationsJson(
      JSON.stringify([
        {
          id: "conv-1",
          title: "Monitor setup",
          create_time: 1714320000,
          update_time: 1714320600,
          mapping: {
            later: {
              message: {
                id: "later",
                author: { role: "assistant" },
                create_time: 1714320500,
                content: { parts: ["Use a USB-C hub."] }
              }
            },
            empty: {
              message: {
                id: "empty",
                author: { role: "user" },
                create_time: 1714320100,
                content: { parts: [""] }
              }
            },
            earlier: {
              message: {
                id: "earlier",
                author: { role: "user" },
                create_time: 1714320001,
                content: { parts: ["I want fewer devices on my desk."] }
              }
            }
          }
        }
      ])
    );

    expect(conversations).toHaveLength(1);
    expect(conversations[0].sourceId).toBe("conv-1");
    expect(conversations[0].turns.map((turn) => turn.id)).toEqual(["earlier", "later"]);
    expect(conversations[0].turns[0].role).toBe("user");
  });

  it("throws a clear error for malformed conversations.json", () => {
    expect(() => parseChatGptConversationsJson("{")).toThrow(ChatGptParseError);
  });

  it("loads conversations.json from a ZIP", async () => {
    const zip = new JSZip();
    zip.file(
      "nested/conversations.json",
      JSON.stringify([
        {
          id: "conv-zip",
          title: "ZIP import",
          mapping: {
            message: {
              message: {
                author: { role: "user" },
                content: { parts: ["Import this."] }
              }
            }
          }
        }
      ])
    );

    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const conversations = await parseChatGptExportZip(buffer);

    expect(conversations[0].sourceId).toBe("conv-zip");
    expect(conversations[0].turns[0].text).toBe("Import this.");
  });

  it("loads split conversations-000.json files from a ZIP", async () => {
    const zip = new JSZip();
    zip.file(
      "conversations-001.json",
      JSON.stringify([
        {
          conversation_id: "conv-split-2",
          title: "Split import 2",
          mapping: {
            message: {
              message: {
                author: { role: "user" },
                content: { parts: ["Second split file."] }
              }
            }
          }
        }
      ])
    );
    zip.file(
      "conversations-000.json",
      JSON.stringify([
        {
          conversation_id: "conv-split-1",
          title: "Split import 1",
          mapping: {
            message: {
              message: {
                author: { role: "user" },
                content: { parts: ["First split file."] }
              }
            }
          }
        }
      ])
    );

    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const conversations = await parseChatGptExportZip(buffer);

    expect(conversations.map((conversation) => conversation.sourceId)).toEqual([
      "conv-split-1",
      "conv-split-2"
    ]);
  });

  it("rejects ZIPs without conversations.json", async () => {
    const zip = new JSZip();
    zip.file("README.txt", "no conversations here");
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    await expect(parseChatGptExportZip(buffer)).rejects.toThrow(/conversations\.json/);
  });
});
