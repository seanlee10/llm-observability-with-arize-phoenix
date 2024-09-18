import os
import json
import boto3
import psycopg
import gradio as gr

from langchain_aws import ChatBedrock, BedrockEmbeddings
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain.docstore.document import Document
from langchain_core.runnables import RunnableLambda
from langchain_postgres import PGVector
from phoenix.trace.langchain import LangChainInstrumentor

MODEL_ID = os.environ.get("MODEL_ID")
os.environ["PHOENIX_COLLECTOR_ENDPOINT"] = "http://localhost:6006"
LangChainInstrumentor().instrument()

session = boto3.session.Session()
client = session.client(
    service_name='secretsmanager', region_name="us-east-1"
)

response = client.get_secret_value(SecretId="phoenix-demo-db-credential")
secret = json.loads(response['SecretString'])

connection = f"postgresql://{secret['username']}:{secret['password']}@{secret['host']}:{secret['port']}/{secret['dbname']}"

# Establish the connection to the database
conn = psycopg.connect(
    conninfo = connection
)

# function to create vector store
def create_vectorstore(embeddings, collection_name, conn):
    vectorstore = PGVector(
        embeddings=embeddings,
        collection_name=collection_name,
        connection=conn,
        use_jsonb=True,
    )
    return vectorstore

bedrock_client = boto3.client("bedrock-runtime", region_name="us-east-1") 
bedrock_embeddings = BedrockEmbeddings(model_id="amazon.titan-embed-text-v2:0", client=bedrock_client)
collection_name_text = "aws_whitepapers"
vectorstore = create_vectorstore(bedrock_embeddings, collection_name_text, connection)


template = """
You are an AI assistant tasked with answering questions based on provided context. Your goal is to provide accurate and relevant answers using only the information given.

Here is the context you should use to answer the question:

<context>
{context}
</context>

Now, here is the question you need to answer:

<question>
{query}
</question>



Instructions:
1. Carefully read and analyze the provided context.
2. Identify key information in the context that is relevant to the question.
3. Formulate an answer to the question using only the information from the given context.
4. If the context does not contain enough information to fully answer the question, state this clearly in your response.
5. Do not use any external knowledge or information not present in the provided context.
6. Keep your answer concise and to the point, while ensuring it fully addresses the question.

Format your response as follows:
1. Begin with a brief answer to the question.
2. Follow with a more detailed explanation, if necessary.
3. If you're quoting directly from the context, use quotation marks and indicate the quote's location in the context.

Remember, it's important to rely solely on the given context and not to introduce any external information or assumptions in your answer.
Assistant:"""
prompt = ChatPromptTemplate.from_template(template)
parser = StrOutputParser()

llm = ChatBedrock(
    model_id=MODEL_ID,
    region_name="us-east-1",
)

def parse_input(message):
    return {
        "question": message
    }

def parse_docs(docs):
    return {
        'query': query,
        'context': docs
    }

def predict(message, history):
    chain = vectorstore.as_retriever() | (lambda x: {'query': message, 'context': x}) |prompt | llm | parser
    response = chain.invoke(message)

    return response


gr.ChatInterface(predict).launch()