'use strict';
/**
 * S3 helpers. Buckets are private (block public access); files are only reached
 * through presigned URLs that expire after 5 minutes (Section 4.2, Threat 7).
 */
const aws = require('./awsClients');
const { PRESIGNED_URL_TTL_SECONDS } = require('./constants');

/**
 * Presigned PUT for a browser upload (CSV guest-list import).
 * The Content-Type is part of the signature, so the browser must send exactly this type.
 */
async function presignPut({ bucket, key, contentType = 'text/csv' }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  const url = await getSignedUrl(aws.s3Presigner(), command, { expiresIn: PRESIGNED_URL_TTL_SECONDS });
  return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expires_in: PRESIGNED_URL_TTL_SECONDS };
}

/** Presigned GET that downloads as an attachment (attendance report CSV). */
async function presignGet({ bucket, key, downloadName, contentType = 'text/csv' }) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const safeName = String(downloadName || 'download.csv').replace(/[^A-Za-z0-9._-]/g, '_');
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
    ResponseContentType: contentType,
  });
  const url = await getSignedUrl(aws.s3Presigner(), command, { expiresIn: PRESIGNED_URL_TTL_SECONDS });
  return { url, expires_in: PRESIGNED_URL_TTL_SECONDS };
}

async function putObject({ bucket, key, body, contentType = 'text/csv; charset=utf-8' }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await aws.s3().send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }),
  );
}

async function headObject({ bucket, key }) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  return aws.s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

/** Reads a whole (small, size-checked) object as UTF-8 text. */
async function getObjectText({ bucket, key }) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await aws.s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return out.Body.transformToString('utf-8');
}

module.exports = { presignPut, presignGet, putObject, headObject, getObjectText };
