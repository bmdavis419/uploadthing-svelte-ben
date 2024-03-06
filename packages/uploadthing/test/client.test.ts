// @vitest-environment happy-dom

import express from "express";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { describe } from "node:test";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { generateUploadThingURL } from "@uploadthing/shared";

import { genUploader } from "../src/client";
import { createRouteHandler, createUploadthing } from "../src/express";
import {
  fetchMock,
  handlers,
  middlewareMock,
  mockExternalRequests,
  onErrorMock,
  s3Mock,
  uploadCompleteMock,
} from "./__test-helpers";

const msw = setupServer(...handlers);
beforeAll(() => msw.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => msw.resetHandlers());
afterAll(() => msw.close());

const setupUTServer = () => {
  const f = createUploadthing();
  const router = {
    foo: f({ text: {} })
      .middleware(() => {
        middlewareMock();
        return {};
      })
      .onUploadError(onErrorMock)
      .onUploadComplete(uploadCompleteMock),
  };

  const app = express();
  app.use(
    "/api/uploadthing",
    createRouteHandler({
      router,
      config: {
        uploadthingSecret: "sk_test_123",
        fetch: mockExternalRequests,
      },
    }),
  );

  const server = app.listen();
  const port = (server.address() as { port: number }).port;

  const uploadFiles = genUploader<typeof router>({
    package: "vitest",
    url: `http://localhost:${port}`,
  });

  return { uploadFiles, close: () => server.close() };
};

describe("uploadFiles", () => {
  it("uploads with presigned post", async () => {
    const { uploadFiles, close } = setupUTServer();
    const file = new File(["foo"], "foo.txt", { type: "text/plain" });

    await expect(
      uploadFiles("foo", {
        files: [file],
        skipPolling: true,
      }),
    ).resolves.toEqual([
      {
        name: "foo.txt",
        size: 3,
        type: "text/plain",
        customId: null,
        serverData: null,
        key: "abc-123.txt",
        url: "https://utfs.io/f/abc-123.txt",
      },
    ]);

    expect(s3Mock).toHaveBeenCalledOnce();
    expect(s3Mock).toHaveBeenCalledWith({}, expect.any(Request));

    expect(middlewareMock).toHaveBeenCalledOnce();
    expect(onErrorMock).not.toHaveBeenCalled();
    // expect(uploadCompleteMock).toHaveBeenCalledOnce();

    close();
  });

  it("uploads with multipart upload", async () => {
    const { uploadFiles, close } = setupUTServer();
    const bigFile = new File([new ArrayBuffer(10 * 1024 * 1024)], "foo.txt", {
      type: "text/plain",
    });

    await expect(
      uploadFiles("foo", {
        files: [bigFile],
        skipPolling: true,
      }),
    ).resolves.toEqual([
      {
        name: "foo.txt",
        size: 10485760,
        type: "text/plain",
        customId: null,
        serverData: null,
        key: "abc-123.txt",
        url: "https://utfs.io/f/abc-123.txt",
      },
    ]);

    expect(s3Mock).toHaveBeenCalledTimes(2);
    expect(s3Mock).toHaveBeenCalledWith(
      { key: "abc-123.txt" },
      expect.any(Request),
    );

    expect(middlewareMock).toHaveBeenCalledOnce();
    expect(onErrorMock).not.toHaveBeenCalled();
    // expect(uploadCompleteMock).toHaveBeenCalledOnce();

    close();
  });

  it("reports of failed post upload", async () => {
    msw.resetHandlers(
      http.post("https://bucket.s3.amazonaws.com", ({ params, request }) => {
        s3Mock(params, request);
        return HttpResponse.json(null, { status: 403 });
      }),
    );

    const { uploadFiles, close } = setupUTServer();
    const file = new File(["foo"], "foo.txt", { type: "text/plain" });

    await expect(
      uploadFiles("foo", {
        files: [file],
        skipPolling: true,
      }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Failed to upload file foo.txt to S3]`,
    );

    expect(s3Mock).toHaveBeenCalledOnce();
    expect(onErrorMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      generateUploadThingURL("/api/failureCallback"),
      {
        body: '{"fileKey":"abc-123.txt","uploadId":null}',
        headers: {
          "Content-Type": "application/json",
          "x-uploadthing-api-key": "sk_test_123",
          "x-uploadthing-be-adapter": "express",
          "x-uploadthing-fe-package": "vitest",
          "x-uploadthing-version": expect.stringMatching(/\d+\.\d+\.\d+/),
        },
        method: "POST",
      },
    );

    close();
  });

  it("reports of failed multipart upload", async () => {
    msw.resetHandlers(
      http.put(
        "https://bucket.s3.amazonaws.com/:key",
        ({ params, request }) => {
          s3Mock(params, request);
          return HttpResponse.json(null, { status: 200 });
        },
      ),
    );

    const { uploadFiles, close } = setupUTServer();
    const bigFile = new File([new ArrayBuffer(10 * 1024 * 1024)], "foo.txt", {
      type: "text/plain",
    });

    await expect(
      uploadFiles("foo", {
        files: [bigFile],
        skipPolling: true,
      }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Failed to upload file foo.txt to S3]`,
    );

    expect(s3Mock).toHaveBeenCalledTimes(2);
    expect(onErrorMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      generateUploadThingURL("/api/failureCallback"),
      {
        body: '{"fileKey":"abc-123.txt","uploadId":"random-upload-id"}',
        headers: {
          "Content-Type": "application/json",
          "x-uploadthing-api-key": "sk_test_123",
          "x-uploadthing-be-adapter": "express",
          "x-uploadthing-fe-package": "vitest",
          "x-uploadthing-version": expect.stringMatching(/\d+\.\d+\.\d+/),
        },
        method: "POST",
      },
    );

    close();
  });
});
