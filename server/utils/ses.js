// ses.js

const {SESClient, SendEmailCommand} = require('@aws-sdk/client-ses');

// Create SES client instance
/*
    In local dev, AWS_ENDPOINT_URL points to LocalStack (http://localhost:4566)
    In production, it is not set so the SDK uses real AWS endpoints automatically
*/
const sesClientConfig = {region: process.env.AWS_REGION};
if(process.env.AWS_ENDPOINT_URL) {
    sesClientConfig.endpoint = process.env.AWS_ENDPOINT_URL;
}
const sesClient = new SESClient(sesClientConfig);

// General purpose email sender
const sendEmail = async(to, subject, body) => {
    const command = new SendEmailCommand({
        Source: process.env.SES_SENDER_EMAIL,
        Destination: {
            ToAddresses: [to]
        },
        Message: {
            Subject: {
                Data: subject
            }, 
            Body: {
                Text: {
                    Data: body
                }
            }
        }
    });
    await sesClient.send(command);
};

// Notify parent when recording is scheduled
const notifyParentScheduled = (parentEmail, parentName, babyName, recordingTitle, scheduledTime) => {
    return sendEmail(
        parentEmail,
        'Your recording has been scheduled',
        `Dear ${parentName},\n\nYour voice recording "${recordingTitle}" for ${babyName} has been approved and scheduled for playback on ${scheduledTime}. We will notify you once it has been played.\n\nThank you for sharing your voice with us!\n\nBest regards,\nVoice2Baby Team`
    );
};

// Notify parent when recording is rescheduled
const notifyParentRescheduled = (parentEmail, parentName, babyName, recordingTitle, newScheduledTime) => {
    return sendEmail(
        parentEmail,
        'Your recording has been rescheduled',
        `Dear ${parentName},\n\nYour voice recording "${recordingTitle}" for ${babyName} has been rescheduled for playback on ${newScheduledTime}. We will notify you once it has been played.\n\nThank you for sharing your voice with us!\n\nBest regards,\nVoice2Baby Team`
    );
};

// Notify parent when recording has been played
const notifyParentPlayed = (parentEmail, parentName, babyName, recordingTitle) => {
    return sendEmail(
        parentEmail,
        'Your recording was played for your baby',
        `Dear ${parentName},\n\nYour voice recording "${recordingTitle}" for ${babyName} has been played at the incubator. Your baby heard your voice today.\n\nThank you for sharing your voice with us!\n\nBest regards,\nVoice2Baby Team`
    );
};

// Notify parent when recording is rejected
const notifyParentRejected = (parentEmail, parentName, babyName, recordingTitle, reason) => {
    return sendEmail(
        parentEmail,
        'Update on your recording',
        `Dear ${parentName},\n\nYour voice recording "${recordingTitle}" for ${babyName} was not approved for playback at this time.\n\nReason: ${reason}\n\nYou are welcome to submit a new recording.\n\nThank you for sharing your voice with us!\n\nBest regards,\nVoice2Baby Team`
    );
};

// Notify a newly-provisioned nurse or parent with their account-activation link.
// role: 'nurse' | 'parent'. rawToken is the plaintext invite token (never the hash).
const notifyInvite = (email, firstName, role, rawToken) => {
    const signupUrl = `${process.env.FRONTEND_URL}/signup?token=${rawToken}`;
    return sendEmail(
        email,
        'You\'ve been invited to Voice2Baby',
        `Dear ${firstName},\n\nAn account has been created for you as a ${role} on Voice2Baby. Please activate your account and set your password using the link below within 48 hours:\n\n${signupUrl}\n\nIf you did not expect this invitation, please contact your hospital administrator.\n\nBest regards,\nVoice2Baby Team`
    );
};

module.exports = {
    notifyParentScheduled,
    notifyParentRescheduled,
    notifyParentPlayed,
    notifyParentRejected,
    notifyInvite
};