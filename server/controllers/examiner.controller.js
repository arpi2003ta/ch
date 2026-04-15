import { Exam, ExamSubmission } from "../models/AIExaminer.model.js";
import { uploadMedia, deleteMediaFromCloudinary } from "../utils/cloudinary.js";
import { evaluateNeetOMR } from "../utils/neetOmrEvaluator.js";
import axios from "axios";

const OMR_API_URL = process.env.OMR_API_URL || "http://localhost:4000";

export const getStudentAnswers = async (imageUrl, useAi = false) => {
  const response = await axios.post(`${OMR_API_URL}/api/omr/predict`, {
    imageUrl,
    useAi,
  });

  if (!response.data.success) {
    throw new Error(response.data.error || "OMR prediction failed");
  }

  return response.data.answers;
};

export const uploadExam = async (req, res) => {
  try {
    const instructorId = req.id;
    const { name } = req.body;
    const existingExam = await Exam.findOne();

    let newExamData = {};
    let oldPublicIds = [];

    if (name) newExamData.name = name;

    if (req.files && req.files.questions) {
      const questionFile = req.files.questions[0];
      // pass whole file object — cloudinary.js uses file.mimetype and file.buffer
      const questionResponse = await uploadMedia(questionFile);
      if (!questionResponse) {
        return res.status(400).json({ message: "Error on uploading question file" });
      }
      newExamData.questionPaper = {
        url: questionResponse.secure_url,
        publicId: questionResponse.public_id,
      };
      if (existingExam?.questionPaper) {
        oldPublicIds.push(existingExam.questionPaper.publicId);
      }
    }

    if (req.files && req.files.answerKey) {
      const answerKeyFile = req.files.answerKey[0];
      const answerKeyResponse = await uploadMedia(answerKeyFile);
      if (!answerKeyResponse) {
        return res.status(400).json({ message: "Error on uploading answerkey file" });
      }
      newExamData.answerKey = {
        url: answerKeyResponse.secure_url,
        publicId: answerKeyResponse.public_id,
      };
      if (existingExam?.answerKey) {
        oldPublicIds.push(existingExam.answerKey.publicId);
      }
    }

    if (req.files && req.files.omr) {
      const omrFile = req.files.omr[0];
      const omrResponse = await uploadMedia(omrFile);
      if (!omrResponse) {
        return res.status(400).json({ message: "Error on uploading omr file" });
      }
      newExamData.omrSheet = {
        url: omrResponse.secure_url,
        publicId: omrResponse.public_id,
      };
      if (existingExam?.omrSheet) {
        oldPublicIds.push(existingExam.omrSheet.publicId);
      }
    }

    if (existingExam) {
      existingExam.set(newExamData);
      const updatedExam = await existingExam.save();

      if (oldPublicIds.length > 0) {
        await Promise.all(
          oldPublicIds.filter(Boolean).map((id) => deleteMediaFromCloudinary(id))
        );
      }

      return res.status(200).json({
        success: true,
        message: "Exam updated successfully",
        exam: updatedExam,
      });
    } else {
      if (!newExamData.name || !newExamData.questionPaper || !newExamData.answerKey || !newExamData.omrSheet) {
        return res.status(400).json({ message: "upload all files" });
      }
      newExamData.instructor = instructorId;
      const newExam = await Exam.create(newExamData);
      return res.status(200).json({
        success: true,
        message: "exam uploaded successfully",
        newExam,
      });
    }
  } catch (err) {
    console.error("uploadExam error:", err);
    return res.status(400).json({ message: "Server error on exam upload" });
  }
};

export const getExam = async (req, res) => {
  try {
    const exam = await Exam.findOne().select("-answerKey");
    if (!exam) {
      return res.status(404).json({ message: "no exam has been uploaded yet" });
    }

    return res.status(200).json({
      success: true,
      message: "Exam details",
      examDetail: {
        _id: exam._id,
        name: exam.name,
        questionPaperUrl: exam.questionPaper.url,
        omrSheetUrl: exam.omrSheet.url,
      },
    });
  } catch (err) {
    return res.status(400).json({ message: "error on hitting getExam controller", error: err });
  }
};

export const submitOmr = async (req, res) => {
  try {
    const studentId = req.id;

    const exam = await Exam.findOne();
    if (!exam) {
      return res.status(404).json({ success: false, message: "Exam not found" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Please upload filled OMR" });
    }

    // CORRECT: pass req.file directly (has .mimetype and .buffer from memoryStorage)
    const omrResponse = await uploadMedia(req.file);
    if (!omrResponse?.secure_url || !omrResponse?.public_id) {
      return res.status(400).json({ success: false, message: "Failed to upload OMR to cloudinary" });
    }

    const newSubmission = await ExamSubmission.create({
      exam: exam._id,
      student: studentId,
      filledOmr: {
        url: omrResponse.secure_url,
        publicId: omrResponse.public_id,
      },
    });

    // Step 1: detect answer key from answer key OMR image
    let answerKey = [];
    try {
      const rawAnswerKey = await getStudentAnswers(exam.answerKey.url, false);

      answerKey = rawAnswerKey
        .filter((a) => a.selectedOption !== null)
        .map((a) => {
          let subject = "physics";
          if (a.questionNumber >= 51 && a.questionNumber <= 100) subject = "chemistry";
          if (a.questionNumber >= 101) subject = "biology";
          return {
            questionNumber: a.questionNumber,
            correctOption: a.selectedOption,
            subject,
          };
        });
    } catch (err) {
      console.error("Answer key ML failed:", err.message);
      return res.status(500).json({ success: false, message: "Answer key processing failed" });
    }

    if (answerKey.length === 0) {
      return res.status(500).json({ success: false, message: "Answer key is missing or invalid" });
    }

    // Step 2: detect student answers from filled OMR
    let detectedAnswers = [];
    try {
      detectedAnswers = await getStudentAnswers(newSubmission.filledOmr.url, false);
    } catch (err) {
      console.error("Student OMR detection failed:", err.message);
      return res.status(500).json({ success: false, message: "Student OMR detection failed" });
    }

    // Step 3: merge
    const studentAnswersComplete = answerKey.map((q) => {
      const detected = detectedAnswers.find(
        (a) => a.questionNumber === q.questionNumber
      );
      return detected || { questionNumber: q.questionNumber, selectedOption: null };
    });

    newSubmission.detectedMarks = studentAnswersComplete;

    // Step 4: evaluate
    const evaluation = evaluateNeetOMR({ answerKey, studentAnswers: studentAnswersComplete });
    newSubmission.evaluation = evaluation;
    await newSubmission.save();

    return res.status(200).json({
      success: true,
      message: "Your Filled OMR Submitted Successfully",
      submissionId: newSubmission._id,
      detectedMarks: studentAnswersComplete,
      evaluation,
    });
  } catch (error) {
    console.error("submitOmr full error:", error);
    return res.status(500).json({
      success: false,
      message: "Error while submitting OMR",
      error: error.message,
    });
  }
};

export const getExamResult = async (req, res) => {
  try {
    const { submissionId } = req.params;
    if (!submissionId) {
      return res.status(400).json({ message: "submissionId is required" });
    }

    const submission = await ExamSubmission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ message: "submission not found" });
    }

    if (!submission.evaluation) {
      return res.status(400).json({ message: "evaluation not available yet" });
    }

    return res.status(200).json({
      success: true,
      message: "Exam evaluation fetched successfully",
      detectedMarks: submission.detectedMarks || [],
      evaluation: submission.evaluation,
    });
  } catch (err) {
    return res.status(500).json({ message: "error on fetching exam evaluation", error: err });
  }
};

export const getDetectedAnswers = async (req, res) => {
  try {
    const { submissionId } = req.params;
    if (!submissionId) {
      return res.status(400).json({ message: "submissionId is required" });
    }

    const submission = await ExamSubmission.findById(submissionId).select("detectedMarks");
    if (!submission) {
      return res.status(404).json({ message: "submission not found" });
    }

    return res.status(200).json({
      success: true,
      detectedAnswers: submission.detectedMarks || [],
    });
  } catch (error) {
    return res.status(500).json({
      message: "error on fetching detected answers",
      error: error.toString(),
    });
  }
};

export const evaluateOmr = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { answerKey } = req.body;

    if (!submissionId) return res.status(400).json({ message: "submissionId is required" });
    if (!Array.isArray(answerKey)) return res.status(400).json({ message: "answerKey must be an array" });

    const submission = await ExamSubmission.findById(submissionId);
    if (!submission) return res.status(404).json({ message: "submission not found" });

    const detectedAnswers = await getStudentAnswers(submission.filledOmr.url, false);
    if (!Array.isArray(detectedAnswers)) {
      return res.status(500).json({ message: "ML detection failed" });
    }

    const evaluation = evaluateNeetOMR({ answerKey, studentAnswers: detectedAnswers });
    submission.detectedMarks = detectedAnswers;
    submission.evaluation = evaluation;
    await submission.save();

    return res.status(200).json({
      success: true,
      message: "OMR evaluated successfully",
      detectedMarks: detectedAnswers,
      evaluation,
    });
  } catch (error) {
    return res.status(500).json({ message: "error on evaluating OMR", error: error.message });
  }
};