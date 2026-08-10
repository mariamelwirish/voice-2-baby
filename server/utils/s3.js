// s3.js

// Import the client and necessary commands & functions from the AWS SDK
const {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand} = require('@aws-sdk/client-s3');
const {getSignedUrl} = require('@aws-sdk/s3-request-presigner');

// For generating unique keys for S3 objects
const{v4 : uuidv4} = require('uuid');

// Create S3 client instance
/* 
    In local dev, AWS_ENDPOINT_URL points to LocalStack (http://localhost:4566)
    In production, it is not set so the SDK uses real AWS endpoints automatically
*/ 
const s3ClientConfig = {region: process.env.AWS_REGION};
if(process.env.AWS_ENDPOINT_URL) {
    s3ClientConfig.endpoint = process.env.AWS_ENDPOINT_URL;
    s3ClientConfig.forcePathStyle = true; // needed for localstack
}
const s3Client = new S3Client(s3ClientConfig);

// Uploads an audio file to S3 and returns the S3 key
const uploadAudio = async(fileBuffer, mimeType) => {
    const key = `recordings/${uuidv4()}`;
    const command = new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType
    });

    await s3Client.send(command);
    return key;
}

// Generates a presigned URL for a given S3 key
// expiresIn: seconds until the URL expires (default 3600 = 1 hour)
const getPresignedUrl = async(key, expiresIn = 3600) => {
    const command = new GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key
    });

    const url = await getSignedUrl(s3Client, command, {expiresIn});
    return url;
}

// Best-effort delete of an S3 object. Called after the DB rows are already
// gone (permanent record deletes), so a failure here must never throw — a
// stray audio object is harmless clutter, not a data-integrity problem.
const deleteAudio = async (key) => {
    if (!key) return;
    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: key
        }));
    } catch (err) {
        console.error(`Failed to delete S3 object ${key}:`, err);
    }
}

module.exports = {uploadAudio, getPresignedUrl, deleteAudio};