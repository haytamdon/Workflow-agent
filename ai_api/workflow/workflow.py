import json
from typing import Generator
from ai_api.db.session import (
    get_db_session,
    WorkflowSession,
    WorkflowClarification,
    WorkflowStep,
    WorkflowParameter
)
from ai_api.agents.needs_clarifier import needs_clarifier
from ai_api.agents.query_enhancer import query_enhancer
from ai_api.agents.workflow_designer import workflow_designer
from ai_api.agents.workflow_creator import workflow_creator
from ai_api.agents.workflow_validator import workflow_validator
from ai_api.agents.parameter_detector import parameter_detector


def yield_text(text: str, event_type: str = "message") -> str:
    """Format SSE response payload."""
    payload = {"content": text}
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


def execute_workflow_step(session_id: str, message: str, answers: dict[str, str]) -> Generator[str, None, None]:
    """Execute the multi-agent stateful workflow step-by-step, logging to database and streaming output."""
    with get_db_session() as db:
        # 1. Retrieve or create session
        session = db.query(WorkflowSession).filter_by(session_id=session_id).first()
        
        if not session:
            # First run: start from scratch
            session = WorkflowSession(
                session_id=session_id,
                prompt=message,
                status="needs_clarifier_running"
            )
            db.add(session)
            db.commit()
            db.refresh(session)
            
        # Handle clarification submission
        if session.status == "needs_clarification":
            yield yield_text("Saving clarifications and initiating design pipeline...\n")
            for key, val in answers.items():
                clar = db.query(WorkflowClarification).filter_by(session_id=session_id, clarification_key=key).first()
                if clar:
                    clar.answer = val
            session.status = "needs_clarifier_completed"
            db.commit()
            
        # Handle parameter submission
        if session.status == "needs_parameters":
            yield yield_text("[Workflow Creator] Injecting parameter values into workflow JSON...\n")
            for key, val in answers.items():
                param = db.query(WorkflowParameter).filter_by(session_id=session_id, missing_parameter_name=key).first()
                if param:
                    param.value = val
            
            session.status = "final_workflow_running"
            db.commit()
            
            # Fetch draft workflow JSON
            draft_step = db.query(WorkflowStep).filter_by(session_id=session_id, agent_name="workflow_creator").first()
            draft_json = draft_step.output_json if draft_step else {}
            
            # Formulate parameters prompt
            param_info = "Parameter values to inject:\n"
            for key, val in answers.items():
                param_info += f"- Parameter `{key}`: `{val}`\n"
                
            creator_prompt = (
                f"Here is the draft workflow JSON:\n{json.dumps(draft_json)}\n\n"
                f"Please update the parameter values in this JSON based on the user's answers:\n{param_info}\n\n"
                f"Return the final updated workflow JSON object only."
            )
            
            log_step = WorkflowStep(
                session_id=session_id,
                agent_name="final_workflow_creator",
                status="running"
            )
            db.add(log_step)
            db.commit()
            
            try:
                response = workflow_creator.run(creator_prompt)
                final_json_str = response.content
                
                try:
                    final_json = json.loads(final_json_str)
                except Exception:
                    import re
                    match = re.search(r"```json\s*(.*?)\s*```", final_json_str, re.DOTALL)
                    if match:
                        final_json = json.loads(match.group(1))
                    else:
                        raise ValueError("Failed to parse JSON output")
                
                session.status = "final_workflow_completed"
                log_step.status = "completed"
                log_step.output_json = final_json
                db.commit()
                
                yield yield_text(f"```json\n{json.dumps(final_json, indent=2)}\n```\n")
                yield yield_text("\nWorkflow is fully complete and ready!\n")
            except Exception as e:
                session.status = "failed"
                log_step.status = "failed"
                log_step.output_text = str(e)
                db.commit()
                yield yield_text(f"\n[Error] Final workflow generation failed: {str(e)}\n")
            return

        # 2. Needs Clarifier Step
        if session.status == "needs_clarifier_running":
            yield yield_text("[Needs Clarifier] Analyzing your request for any missing requirements...\n")
            
            log_step = WorkflowStep(
                session_id=session_id,
                agent_name="needs_clarifier",
                status="running"
            )
            db.add(log_step)
            db.commit()
            
            try:
                response = needs_clarifier.run(prompt=session.prompt)
                questions_list = response.content
                
                questions_dict = [
                    {
                        "id": q.id,
                        "question": q.question,
                        "clarification_key": q.clarification_key
                    }
                    for q in questions_list.questions
                ] if questions_list and hasattr(questions_list, "questions") and questions_list.questions else []
                
                if len(questions_dict) > 0:
                    for q in questions_dict:
                        db.add(WorkflowClarification(
                            session_id=session_id,
                            clarification_key=q["clarification_key"],
                            question=q["question"]
                        ))
                    session.status = "needs_clarification"
                    log_step.status = "completed"
                    log_step.output_json = {"questions": questions_dict}
                    db.commit()
                    
                    questions_json_str = json.dumps({"questions": questions_dict}, indent=2)
                    yield yield_text(f"To design the best possible workflow, please clarify the following:\n```json\n{questions_json_str}\n```\n")
                    return
                else:
                    session.status = "needs_clarifier_completed"
                    log_step.status = "completed"
                    db.commit()
                    yield yield_text("No clarifications needed. Proceeding to design the workflow...\n")
            except Exception as e:
                session.status = "failed"
                log_step.status = "failed"
                log_step.output_text = str(e)
                db.commit()
                yield yield_text(f"\n[Error] Clarification step failed: {str(e)}\n")
                return

        # 3. Design and Compile Pipeline
        if session.status == "needs_clarifier_completed":
            # --- query_enhancer ---
            yield yield_text("[Query Enhancer] Enhancing prompt with best practices...\n")
            session.status = "query_enhancer_running"
            log_step = WorkflowStep(
                session_id=session_id,
                agent_name="query_enhancer",
                status="running"
            )
            db.add(log_step)
            db.commit()
            
            try:
                # Gather clarifications
                clars = db.query(WorkflowClarification).filter_by(session_id=session_id).all()
                context = f"Original Query: {session.prompt}\n\n"
                if clars:
                    context += "Clarifications provided:\n"
                    for c in clars:
                        context += f"- Question: {c.question}\n  Answer: {c.answer}\n"
                
                response = query_enhancer.run(context)
                enhanced_prompt = response.content
                
                session.status = "query_enhancer_completed"
                log_step.status = "completed"
                log_step.output_text = enhanced_prompt
                db.commit()
                
                yield yield_text(f"### Enhanced Prompt:\n{enhanced_prompt}\n")
            except Exception as e:
                session.status = "failed"
                log_step.status = "failed"
                log_step.output_text = str(e)
                db.commit()
                yield yield_text(f"\n[Error] Query enhancement failed: {str(e)}\n")
                return

            # --- workflow_designer ---
            yield yield_text("\n[Workflow Designer] Designing workflow structure...\n")
            session.status = "workflow_designer_running"
            log_step = WorkflowStep(
                session_id=session_id,
                agent_name="workflow_designer",
                status="running"
            )
            db.add(log_step)
            db.commit()
            
            try:
                response = workflow_designer.run(enhanced_prompt)
                design = response.content
                
                session.status = "workflow_designer_completed"
                log_step.status = "completed"
                log_step.output_text = design
                db.commit()
                
                yield yield_text(f"### Workflow Design:\n{design}\n")
            except Exception as e:
                session.status = "failed"
                log_step.status = "failed"
                log_step.output_text = str(e)
                db.commit()
                yield yield_text(f"\n[Error] Workflow design failed: {str(e)}\n")
                return

            # --- workflow_creator ---
            yield yield_text("\n[Workflow Creator] Compiling design to n8n JSON...\n")
            session.status = "workflow_creator_running"
            log_step = WorkflowStep(
                session_id=session_id,
                agent_name="workflow_creator",
                status="running"
            )
            db.add(log_step)
            db.commit()
            
            try:
                response = workflow_creator.run(design)
                creator_json_str = response.content
                
                try:
                    workflow_json = json.loads(creator_json_str)
                except Exception:
                    import re
                    match = re.search(r"```json\s*(.*?)\s*```", creator_json_str, re.DOTALL)
                    if match:
                        workflow_json = json.loads(match.group(1))
                    else:
                        raise ValueError("Failed to parse JSON output")
                
                session.status = "workflow_creator_completed"
                log_step.status = "completed"
                log_step.output_json = workflow_json
                db.commit()
                
                yield yield_text(f"```json\n{json.dumps(workflow_json, indent=2)}\n```\n")
            except Exception as e:
                session.status = "failed"
                log_step.status = "failed"
                log_step.output_text = str(e)
                db.commit()
                yield yield_text(f"\n[Error] Workflow creation failed: {str(e)}\n")
                return

            # --- workflow_validator ---
            yield yield_text("\n[Workflow Validator] Auditing workflow for errors and security rules...\n")
            session.status = "workflow_validator_running"
            log_step = WorkflowStep(
                session_id=session_id,
                agent_name="workflow_validator",
                status="running"
            )
            db.add(log_step)
            db.commit()
            
            try:
                response = workflow_validator.run(json.dumps(workflow_json))
                validation_report = response.content
                
                session.status = "workflow_validator_completed"
                log_step.status = "completed"
                log_step.output_text = validation_report
                db.commit()
                
                yield yield_text(f"### Validation Report:\n{validation_report}\n")
            except Exception as e:
                session.status = "failed"
                log_step.status = "failed"
                log_step.output_text = str(e)
                db.commit()
                yield yield_text(f"\n[Error] Workflow validation failed: {str(e)}\n")
                return

            # --- parameter_detector ---
            yield yield_text("\n[Parameter Detector] Checking for placeholders and credentials...\n")
            session.status = "parameter_detector_running"
            log_step = WorkflowStep(
                session_id=session_id,
                agent_name="parameter_detector",
                status="running"
            )
            db.add(log_step)
            db.commit()
            
            try:
                prompt_to_detector = f"Workflow JSON:\n{json.dumps(workflow_json)}\n\nValidation Report:\n{validation_report}"
                response = parameter_detector.run(prompt_to_detector)
                questions_list = response.content
                
                questions_dict = [
                    {
                        "question": q.question,
                        "missing_parameter_name": q.missing_parameter_name
                    }
                    for q in questions_list.questions
                ] if questions_list and hasattr(questions_list, "questions") and questions_list.questions else []
                
                if len(questions_dict) > 0:
                    for q in questions_dict:
                        db.add(WorkflowParameter(
                            session_id=session_id,
                            missing_parameter_name=q["missing_parameter_name"],
                            question=q["question"]
                        ))
                    session.status = "needs_parameters"
                    log_step.status = "completed"
                    log_step.output_json = {"questions": questions_dict}
                    db.commit()
                    
                    questions_json_str = json.dumps({"questions": questions_dict}, indent=2)
                    yield yield_text(f"The following configuration parameters are required:\n```json\n{questions_json_str}\n```\n")
                    return
                else:
                    session.status = "final_workflow_completed"
                    log_step.status = "completed"
                    
                    # Store as the final workflow JSON in final_workflow_creator output log
                    final_step = WorkflowStep(
                        session_id=session_id,
                        agent_name="final_workflow_creator",
                        status="completed",
                        output_json=workflow_json
                    )
                    db.add(final_step)
                    db.commit()
                    
                    yield yield_text("\nWorkflow is fully complete and ready!\n")
                    return
            except Exception as e:
                session.status = "failed"
                log_step.status = "failed"
                log_step.output_text = str(e)
                db.commit()
                yield yield_text(f"\n[Error] Parameter detection failed: {str(e)}\n")
                return